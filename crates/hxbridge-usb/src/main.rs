mod ops;
mod state;

use std::fmt;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use hx_catalog::Catalog;
use hx_usb::Session;
use serde_json::Value;

const REOPEN: Duration = Duration::from_secs(1);

fn sock_path() -> PathBuf {
    PathBuf::from(
        std::env::var("HXBRIDGE_USB_SOCK").unwrap_or_else(|_| "/tmp/hxbridge-usb.sock".into()),
    )
}

fn open_session() -> hx_usb::Result<Session> {
    let found = hx_usb::list()?;
    let device = found
        .iter()
        .find(|d| d.profile.product_id == 0x4248)
        .or_else(|| found.first())
        .ok_or(hx_usb::Error::NotFound)?;
    eprintln!(
        "opening {} (pid {:04x})",
        device.profile.name, device.profile.product_id
    );
    device.open()
}

struct Usb {
    session: Option<Session>,
    follow: ops::FollowState,
    last_try: Instant,
    quiet_until: Instant,
}

impl Usb {
    fn new() -> Self {
        Self {
            session: None,
            follow: ops::FollowState::default(),
            last_try: Instant::now()
                .checked_sub(REOPEN)
                .unwrap_or_else(Instant::now),
            quiet_until: Instant::now(),
        }
    }

    fn drop_lost(&mut self, why: impl fmt::Display) {
        eprintln!("usb session lost: {why}");
        self.session = None;
        self.follow = ops::FollowState::default();
        self.last_try = Instant::now();
    }

    fn reopen(&mut self, force: bool) {
        if self.session.is_some() {
            return;
        }
        if !force && self.last_try.elapsed() < REOPEN {
            return;
        }
        self.last_try = Instant::now();
        match open_session() {
            Ok(s) => {
                eprintln!("usb session opened");
                self.follow = ops::FollowState::default();
                self.session = Some(s);
            }
            Err(e) => {
                if Instant::now() >= self.quiet_until {
                    eprintln!("waiting for helix: {e}");
                    self.quiet_until = Instant::now() + Duration::from_secs(30);
                }
            }
        }
    }

    fn tick(&mut self) {
        if self.session.is_none() {
            self.reopen(false);
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
        let lost = match self.session.as_mut() {
            Some(session) => match session.keepalive() {
                Err(e) => {
                    eprintln!("keepalive: {e}");
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
}

fn handle_stream(
    stream: UnixStream,
    usb: &mut Usb,
    catalog: Option<&Catalog>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(45)))?;
    stream.set_write_timeout(Some(Duration::from_secs(45)))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let reply = match serde_json::from_str::<Value>(line.trim()) {
        Ok(cmd) => {
            if usb.session.is_none() {
                usb.reopen(true);
            }
            let reply = match (&mut usb.session, &mut usb.follow) {
                (Some(session), follow) => ops::handle(session, catalog, &cmd, follow),
                (None, _) => serde_json::json!({
                    "ok": false,
                    "error": "helix not connected",
                }),
            };
            if reply.get("lost").and_then(Value::as_bool) == Some(true) {
                let why = reply
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("transport error")
                    .to_string();
                usb.drop_lost(why);
            }
            reply
        }
        Err(e) => serde_json::json!({"ok": false, "error": format!("invalid json: {e}")}),
    };
    let mut stream = reader.into_inner();
    stream.write_all(reply.to_string().as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;
    Ok(())
}

fn unlink(path: &Path) {
    let _ = fs::remove_file(path);
}

fn load_catalog() -> Option<Catalog> {
    match Catalog::load() {
        Ok(c) => {
            eprintln!("catalog loaded ({} models)", c.len());
            return Some(c);
        }
        Err(e) => eprintln!("catalog default path: {e}"),
    }
    let local = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    match Catalog::load_from(&local) {
        Ok(c) => {
            eprintln!(
                "catalog loaded from {} ({} models)",
                local.display(),
                c.len()
            );
            Some(c)
        }
        Err(e) => {
            eprintln!("catalog not loaded: {e}");
            None
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = sock_path();
    unlink(&path);

    let running = Arc::new(AtomicBool::new(true));
    let flag = running.clone();
    let sock = path.clone();
    ctrlc::set_handler(move || {
        flag.store(false, Ordering::SeqCst);
        unlink(&sock);
    })?;

    let catalog = load_catalog();
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    eprintln!("listening on {}", path.display());

    let mut usb = Usb::new();
    usb.reopen(true);

    let mut last_ka = Instant::now();
    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Err(e) = handle_stream(stream, &mut usb, catalog.as_ref()) {
                    eprintln!("client: {e}");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                usb.tick();
                if last_ka.elapsed() >= Duration::from_secs(2) {
                    usb.keepalive();
                    last_ka = Instant::now();
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                eprintln!("accept: {e}");
                thread::sleep(Duration::from_millis(50));
            }
        }
    }

    unlink(&path);
    eprintln!("usb session released");
    Ok(())
}
