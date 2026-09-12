mod usb_wire;

use std::collections::VecDeque;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use esp_idf_sys as _;

use hx_catalog::Catalog;
use hx_proto::{profile_for, HELIX_FLOOR};
use hx_usb::Session;
use hxbridge_usb::ops::{self, FollowState};
use serde_json::{json, Value};
use std::path::Path;

use crate::usb_wire::EspWire;

mod ffi {
    use std::os::raw::c_char;

    extern "C" {
        pub fn tonerelay_start();
        pub fn helix_usb_open(pid_out: *mut u16) -> i32;
        pub fn helix_usb_present() -> bool;
        pub fn helix_usb_pid() -> u16;
        pub fn helix_usb_enum_gen() -> u32;
        pub fn helix_usb_stats(
            drops: *mut u32,
            in_ok: *mut u32,
            tx_ok: *mut u32,
            last_n: *mut i32,
            last_st: *mut i32,
            parked: *mut u32,
            queued: *mut u32,
        );
        pub fn helix_usb_last_error() -> *const c_char;
        pub fn tonerelay_wifi_scan_json(buf: *mut c_char, len: usize) -> i32;
        pub fn tonerelay_wifi_join(ssid: *const c_char, pass: *const c_char) -> i32;
        pub fn tonerelay_wifi_ap_password(pass: *const c_char) -> i32;
        pub fn tonerelay_wifi_status_json(buf: *mut c_char, len: usize) -> i32;
        pub fn tonerelay_wifi_forget() -> i32;
        pub fn tonerelay_wifi_setup_required() -> bool;
        pub fn tonerelay_wifi_ap_secured() -> bool;
        pub fn tonerelay_wifi_sta_configured() -> bool;
        pub fn tonerelay_wifi_sta_up() -> bool;
        pub fn tonerelay_catalog_ready() -> bool;
        pub fn tonerelay_ble_up() -> bool;
    }
}

const REOPEN: Duration = Duration::from_secs(15);
const REOPEN_AFTER_SILENCE: Duration = Duration::from_secs(20);

struct Bridge {
    session: Option<Session>,
    follow: FollowState,
    last_try: Instant,
    opening: bool,
    primed: bool,
    /// After a silent handshake, back off before the next HELLO. Cleared on
    /// unplug/re-enumerate so a Helix reboot can retry without a 9V pull.
    hold_open: bool,
    enum_gen: u32,
}

impl Bridge {
    fn new() -> Self {
        Self {
            session: None,
            follow: FollowState::default(),
            last_try: Instant::now()
                .checked_sub(REOPEN)
                .unwrap_or_else(Instant::now),
            opening: false,
            primed: false,
            hold_open: false,
            enum_gen: 0,
        }
    }

    fn drop_lost(&mut self, why: impl std::fmt::Display) {
        log(&format!("usb session lost: {why}"));
        self.session = None;
        self.follow = FollowState::default();
        self.opening = false;
        self.primed = false;
        self.hold_open = true;
        self.last_try = Instant::now();
    }

    fn should_open(&self) -> bool {
        let wait = if self.hold_open {
            REOPEN_AFTER_SILENCE
        } else {
            REOPEN
        };
        self.session.is_none()
            && !self.opening
            && self.last_try.elapsed() >= wait
            && unsafe { ffi::helix_usb_present() }
    }

    fn note_unplugged(&mut self) {
        let gen = unsafe { ffi::helix_usb_enum_gen() };
        if gen != self.enum_gen {
            self.enum_gen = gen;
            if !unsafe { ffi::helix_usb_present() } {
                log("usb re-enumerated; retry handshake");
                self.hold_open = false;
                self.last_try = Instant::now()
                    .checked_sub(REOPEN)
                    .unwrap_or_else(Instant::now);
            }
        }
        if !unsafe { ffi::helix_usb_present() } {
            self.hold_open = false;
        }
    }

    fn tick(&mut self) {
        if self.session.is_none() {
            return;
        }
        if !unsafe { ffi::helix_usb_present() } {
            self.drop_lost("device gone");
            self.hold_open = false;
            return;
        }
        if !self.primed {
            return;
        }
        let notes = self
            .session
            .as_mut()
            .map(Session::poll_notifications)
            .unwrap_or_default();
        self.follow.note(&notes);
    }

    fn keepalive(&mut self) {
        if !self.primed {
            return;
        }
        let lost = match self.session.as_mut() {
            Some(session) => match session.keepalive() {
                Err(e) => {
                    log(&format!("keepalive: {e}"));
                    e.loses_session().then(|| e.to_string())
                }
                Ok(()) => None,
            },
            None => None,
        };
        if let Some(why) = lost {
            self.drop_lost(why);
        }
    }

    fn handle(&mut self, mut cmd: Value) -> Value {
        let id = cmd.get("id").cloned();
        if let Some(obj) = cmd.as_object_mut() {
            obj.remove("id");
        }
        let op = cmd.get("op").and_then(Value::as_str).unwrap_or("");
        let mut reply = match op {
            "wifi_scan" => wifi_scan(),
            "wifi_join" => wifi_join(&cmd),
            "wifi_ap_password" => wifi_ap_password(&cmd),
            "wifi_status" => wifi_status(),
            "wifi_forget" => {
                unsafe {
                    ffi::tonerelay_wifi_forget();
                }
                json!({"ok": true, "op": "wifi_forget"})
            }
            "ping" => json!({"ok": true, "op": "ping", "pong": true}),
            "info" => self.info(),
            _ => {
                let t0 = Instant::now();
                let reply = match op {
                    "list_favorites" => json!({
                        "ok": true,
                        "op": "list_favorites",
                        "count": 0,
                        "favorites": []
                    }),
                    "list_irs" => json!({
                        "ok": true,
                        "op": "list_irs",
                        "count": 0,
                        "irs": []
                    }),
                    _ => self.usb_op(&cmd),
                };
                if op != "wifi_join" && !op.is_empty() {
                    let ok = reply.get("ok").and_then(Value::as_bool) == Some(true);
                    let err = reply.get("error").and_then(Value::as_str).unwrap_or("");
                    log(&format!(
                        "op {op} {}ms ok={ok}{}",
                        t0.elapsed().as_millis(),
                        if err.is_empty() {
                            String::new()
                        } else {
                            format!(" err={err}")
                        }
                    ));
                }
                if !matches!(reply.get("ok").and_then(Value::as_bool), Some(true)) {
                    if let Some(session) = self.session.as_ref() {
                        log(&format!("{op} stats={:?}", session.channel_stats()));
                    }
                }
                reply
            }
        };
        if let Some(id) = id {
            reply["id"] = id;
        }
        if reply.get("lost").and_then(Value::as_bool) == Some(true) {
            let why = reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("transport error")
                .to_string();
            // A CONTROL list timeout must not tear down a live DATA session.
            // drop_lost closes USB and immediately handshakes again, which is
            // what leaves the Helix needing its 9V pulled.
            if why.contains("timed out") {
                log(&format!("usb timeout kept session: {why}"));
            } else {
                self.drop_lost(why);
            }
        }
        reply
    }

    fn info(&mut self) -> Value {
        let usb = self.session.is_some();
        let present = unsafe { ffi::helix_usb_present() };
        let mut body = json!({
            "ok": true,
            "op": "info",
            "usb": usb,
            "present": present,
            "vid": "0e41",
            "pid": format!("{:04x}", unsafe { ffi::helix_usb_pid() }),
            "product": "HELIX",
            "ops": [
                "ping", "info", "wifi_scan", "wifi_join", "wifi_ap_password",
                "wifi_status", "wifi_forget"
            ],
            "note": if usb {
                "ESP32-P4 ToneRelay"
            } else if present {
                "ESP32-P4 ToneRelay; Helix connecting"
            } else {
                "ESP32-P4 ToneRelay; Helix not connected"
            },
        });
        decorate(&mut body);
        let trace: Vec<String> = traces()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        body["trace"] = json!(trace);
        body["opening"] = json!(self.opening);
        body["hold_open"] = json!(self.hold_open);
        let mut drops = 0u32;
        let mut in_ok = 0u32;
        let mut tx_ok = 0u32;
        let mut last_n = 0i32;
        let mut last_st = 0i32;
        let mut parked = 0u32;
        let mut queued = 0u32;
        unsafe {
            ffi::helix_usb_stats(
                &mut drops,
                &mut in_ok,
                &mut tx_ok,
                &mut last_n,
                &mut last_st,
                &mut parked,
                &mut queued,
            );
        }
        body["usb_stats"] = json!({
            "drops": drops,
            "in_ok": in_ok,
            "tx_ok": tx_ok,
            "parked": parked,
            "queued": queued,
            "last_in_n": last_n,
            "last_in_status": last_st,
        });
        body
    }

    fn usb_op(&mut self, cmd: &Value) -> Value {
        match self.session.as_mut() {
            Some(session) => {
                let cat = catalog_slot().lock().unwrap_or_else(|e| e.into_inner());
                ops::handle(session, cat.as_ref(), cmd, &mut self.follow)
            }
            None => json!({
                "ok": false,
                "op": cmd.get("op"),
                "error": if unsafe { ffi::helix_usb_present() } {
                    "helix connecting"
                } else {
                    "helix not connected"
                },
            }),
        }
    }
}

fn decorate(body: &mut Value) {
    body["platform"] = json!("esp32-p4");
    body["setup_required"] = json!(unsafe { ffi::tonerelay_wifi_setup_required() });
    body["ap_secured"] = json!(unsafe { ffi::tonerelay_wifi_ap_secured() });
    body["sta_configured"] = json!(unsafe { ffi::tonerelay_wifi_sta_configured() });
    let cat = catalog_slot().lock().unwrap_or_else(|e| e.into_inner());
    body["catalog"] = json!(cat.is_some());
    body["catalog_ready"] = json!(unsafe { ffi::tonerelay_catalog_ready() });
    body["catalog_models"] = json!(cat.as_ref().map(Catalog::len).unwrap_or(0));
    drop(cat);
    body["ble"] = json!(unsafe { ffi::tonerelay_ble_up() });
    body["wifi_sta"] = json!(unsafe { ffi::tonerelay_wifi_sta_up() });
    let wifi = wifi_status();
    if let Some(obj) = wifi.as_object() {
        body["wifi"] = json!({
            "sta": obj.get("sta"),
            "ssid": obj.get("ssid"),
            "ip": obj.get("ip"),
            "ap": obj.get("ap"),
            "ap_ip": obj.get("ap_ip"),
            "mdns": obj.get("mdns"),
            "ap_secured": obj.get("ap_secured"),
            "sta_configured": obj.get("sta_configured"),
            "catalog_ready": obj.get("catalog_ready"),
        });
    }
}

fn cstr_json(fill: impl Fn(*mut c_char, usize) -> i32, cap: usize) -> Value {
    let mut buf = vec![0u8; cap];
    let n = fill(buf.as_mut_ptr() as *mut c_char, buf.len());
    if n <= 0 {
        return json!({"ok": false, "error": "wifi status failed"});
    }
    let n = (n as usize).min(buf.len().saturating_sub(1));
    serde_json::from_slice(&buf[..n])
        .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}))
}

fn wifi_scan() -> Value {
    cstr_json(|p, n| unsafe { ffi::tonerelay_wifi_scan_json(p, n) }, 4096)
}

fn wifi_status() -> Value {
    cstr_json(
        |p, n| unsafe { ffi::tonerelay_wifi_status_json(p, n) },
        1024,
    )
}

fn wifi_ap_password(cmd: &Value) -> Value {
    let Some(pass) = cmd.get("password").and_then(Value::as_str) else {
        return json!({"ok": false, "op": "wifi_ap_password", "error": "password required"});
    };
    if pass.len() < 8 || pass.len() > 63 {
        return json!({
            "ok": false,
            "op": "wifi_ap_password",
            "error": "password must be 8-63 characters"
        });
    }
    let pass_c = match CString::new(pass) {
        Ok(s) => s,
        Err(_) => {
            return json!({"ok": false, "op": "wifi_ap_password", "error": "password invalid"})
        }
    };
    let rc = unsafe { ffi::tonerelay_wifi_ap_password(pass_c.as_ptr()) };
    if rc == 0 {
        json!({"ok": true, "op": "wifi_ap_password"})
    } else {
        json!({"ok": false, "op": "wifi_ap_password", "error": "could not set password"})
    }
}

fn wifi_join(cmd: &Value) -> Value {
    let Some(ssid) = cmd.get("ssid").and_then(Value::as_str) else {
        return json!({"ok": false, "op": "wifi_join", "error": "ssid required"});
    };
    if ssid.is_empty() || ssid.len() > 32 {
        return json!({"ok": false, "op": "wifi_join", "error": "ssid must be 1-32 bytes"});
    }
    let pass = cmd
        .get("password")
        .or_else(|| cmd.get("pass"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if pass.len() > 64 {
        return json!({"ok": false, "op": "wifi_join", "error": "password too long"});
    }
    let ssid_c = match CString::new(ssid) {
        Ok(s) => s,
        Err(_) => return json!({"ok": false, "op": "wifi_join", "error": "ssid invalid"}),
    };
    let pass_c = match CString::new(pass) {
        Ok(s) => s,
        Err(_) => return json!({"ok": false, "op": "wifi_join", "error": "password invalid"}),
    };
    log(&format!("wifi join ssid={ssid}"));
    let rc = unsafe { ffi::tonerelay_wifi_join(ssid_c.as_ptr(), pass_c.as_ptr()) };
    if rc == 0 {
        json!({"ok": true, "op": "wifi_join", "ssid": ssid})
    } else {
        json!({"ok": false, "op": "wifi_join", "error": "join failed"})
    }
}

fn last_usb_err() -> String {
    let p = unsafe { ffi::helix_usb_last_error() };
    if p.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

fn usb_stat_line() -> String {
    let mut drops = 0u32;
    let mut in_ok = 0u32;
    let mut tx_ok = 0u32;
    let mut last_n = 0i32;
    let mut last_st = 0i32;
    let mut parked = 0u32;
    let mut queued = 0u32;
    unsafe {
        ffi::helix_usb_stats(
            &mut drops,
            &mut in_ok,
            &mut tx_ok,
            &mut last_n,
            &mut last_st,
            &mut parked,
            &mut queued,
        );
    }
    format!("tx={tx_ok} in={in_ok} drops={drops} parked={parked} queued={queued} last_in={last_n}/{last_st}")
}

fn open_session() -> hx_usb::Result<Session> {
    log("usb session opening");
    let t0 = Instant::now();
    let mut pid = 0u16;
    let rc = unsafe { ffi::helix_usb_open(&mut pid) };
    if rc != 0 {
        log(&format!(
            "usb claim failed rc={rc} after {}ms {}",
            t0.elapsed().as_millis(),
            last_usb_err()
        ));
        return Err(hx_usb::Error::NotFound);
    }
    let profile = profile_for(pid).copied().unwrap_or(HELIX_FLOOR);
    // One claim + one handshake. A second claim/release/claim here after a
    // silent HELLO was leaving device_open failing until the Helix 9V was pulled.
    let result = Session::from_wire(Box::new(EspWire), profile);
    match &result {
        Ok(_) => log(&format!(
            "usb handshake ok in {}ms pid={pid:04x} {}",
            t0.elapsed().as_millis(),
            usb_stat_line()
        )),
        Err(e) => log(&format!(
            "usb handshake fail in {}ms: {e} {}",
            t0.elapsed().as_millis(),
            usb_stat_line()
        )),
    }
    result
}

fn traces() -> &'static Mutex<VecDeque<String>> {
    static T: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(VecDeque::with_capacity(48)))
}

fn log(msg: &str) {
    eprintln!("[tonerelay] {msg}");
    let _ = std::io::Write::flush(&mut std::io::stderr());
    let mut q = traces().lock().unwrap_or_else(|e| e.into_inner());
    if q.len() >= 48 {
        q.pop_front();
    }
    q.push_back(msg.to_string());
}

fn bridge() -> &'static Mutex<Bridge> {
    static INIT: OnceLock<Mutex<Bridge>> = OnceLock::new();
    INIT.get_or_init(|| Mutex::new(Bridge::new()))
}

fn catalog_slot() -> &'static Mutex<Option<Catalog>> {
    static C: OnceLock<Mutex<Option<Catalog>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

fn reload_catalog() -> Value {
    if !unsafe { ffi::tonerelay_catalog_ready() } {
        *catalog_slot().lock().unwrap_or_else(|e| e.into_inner()) = None;
        return json!({"ok": false, "error": "catalog files incomplete"});
    }
    match Catalog::load_from(Path::new("/catalog")) {
        Ok(c) => {
            let n = c.len();
            log(&format!("catalog loaded ({n} models)"));
            *catalog_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(c);
            json!({"ok": true, "op": "catalog_commit", "models": n})
        }
        Err(e) => {
            log(&format!("catalog load failed: {e}"));
            *catalog_slot().lock().unwrap_or_else(|e| e.into_inner()) = None;
            json!({"ok": false, "error": e.to_string()})
        }
    }
}

const USB_OP_STACK: usize = 64 * 1024;

struct UsbOpJob {
    cmd: Value,
    reply: SyncSender<String>,
}

fn usb_op_tx() -> &'static Mutex<Option<SyncSender<UsbOpJob>>> {
    static TX: OnceLock<Mutex<Option<SyncSender<UsbOpJob>>>> = OnceLock::new();
    TX.get_or_init(|| Mutex::new(None))
}

fn start_usb_op_worker() {
    let (tx, rx) = mpsc::sync_channel::<UsbOpJob>(0);
    let spawned = thread::Builder::new()
        .name("usb-op".into())
        .stack_size(USB_OP_STACK)
        .spawn(move || {
            while let Ok(job) = rx.recv() {
                let reply = bridge()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .handle(job.cmd);
                let _ = job.reply.send(reply.to_string());
            }
        });
    match spawned {
        Ok(_) => {
            *usb_op_tx().lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
            log("usb-op worker started");
        }
        Err(e) => log(&format!("usb-op worker spawn failed: {e}")),
    }
}

fn run_on_usb_op(cmd: Value) -> String {
    let tx = usb_op_tx()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(tx) = tx else {
        return json!({"ok": false, "error": "usb-op worker missing"}).to_string();
    };
    let (rtx, rrx) = mpsc::sync_channel(1);
    if tx.send(UsbOpJob { cmd, reply: rtx }).is_err() {
        return json!({"ok": false, "error": "usb-op worker dead"}).to_string();
    }
    rrx.recv()
        .unwrap_or_else(|_| json!({"ok": false, "error": "usb-op worker dropped"}).to_string())
}

#[no_mangle]
pub extern "C" fn hxbridge_handle_json(json: *const c_char, json_len: c_int) -> *mut c_char {
    let bytes = if json.is_null() || json_len < 0 {
        b"{}"
    } else {
        unsafe { std::slice::from_raw_parts(json as *const u8, json_len as usize) }
    };
    let text = match serde_json::from_slice::<Value>(bytes) {
        Ok(cmd) => {
            let op = cmd.get("op").and_then(Value::as_str).unwrap_or("");
            // LIST_PRESETS / FETCH_PRESET build a large Value tree. Decode and
            // JSON serialize on a persistent usb-op worker so httpd does not
            // allocate a second large stack (that ENOMEM skipped get_state).
            let heavy = matches!(
                op,
                "list_presets"
                    | "get_state"
                    | "export_preset"
                    | "topology"
                    | "list_irs"
                    | "list_models"
            );
            if heavy {
                run_on_usb_op(cmd)
            } else {
                bridge()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .handle(cmd)
                    .to_string()
            }
        }
        Err(e) => json!({"ok": false, "error": format!("invalid json: {e}")}).to_string(),
    };
    CString::new(text.replace('\0', "")).unwrap().into_raw()
}

fn reload_catalog_on_thread() -> Value {
    let (tx, rx) = mpsc::sync_channel(1);
    match thread::Builder::new()
        .name("cat-load".into())
        .stack_size(USB_OP_STACK)
        .spawn(move || {
            let _ = tx.send(reload_catalog());
        }) {
        Ok(h) => {
            let v = rx
                .recv()
                .unwrap_or_else(|_| json!({"ok": false, "error": "catalog load dropped"}));
            let _ = h.join();
            v
        }
        Err(e) => json!({"ok": false, "error": format!("catalog thread: {e}")}),
    }
}

#[no_mangle]
pub extern "C" fn hxbridge_catalog_reload() -> *mut c_char {
    let text = reload_catalog_on_thread().to_string();
    CString::new(text.replace('\0', "")).unwrap().into_raw()
}

#[no_mangle]
pub extern "C" fn hxbridge_free(p: *mut c_char) {
    if !p.is_null() {
        unsafe {
            drop(CString::from_raw(p));
        }
    }
}

fn main() {
    unsafe {
        ffi::tonerelay_start();
    }
    start_usb_op_worker();
    let _ = reload_catalog_on_thread();
    thread::spawn(|| {
        let mut last_ka = Instant::now();
        loop {
            let start_open = {
                let mut b = bridge().lock().unwrap_or_else(|e| e.into_inner());
                b.note_unplugged();
                b.tick();
                if last_ka.elapsed() >= Duration::from_secs(2) {
                    b.keepalive();
                    last_ka = Instant::now();
                }
                if b.should_open() {
                    b.opening = true;
                    b.last_try = Instant::now();
                    true
                } else {
                    false
                }
            };
            if start_open {
                match open_session() {
                    Ok(s) => {
                        let mut b = bridge().lock().unwrap_or_else(|e| e.into_inner());
                        b.opening = false;
                        b.hold_open = false;
                        b.follow = FollowState::default();
                        b.session = Some(s);
                        b.primed = true;
                        last_ka = Instant::now();
                        log("usb session opened");
                    }
                    Err(e) => {
                        let mut b = bridge().lock().unwrap_or_else(|e| e.into_inner());
                        b.opening = false;
                        b.last_try = Instant::now();
                        if matches!(
                            e,
                            hx_usb::Error::Timeout(_)
                                | hx_usb::Error::Protocol(_)
                                | hx_usb::Error::Usb(_)
                        ) {
                            b.hold_open = true;
                            log(&format!("usb hold until unplug: {e}"));
                        } else {
                            log(&format!("waiting for helix: {e}"));
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
    });
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}
