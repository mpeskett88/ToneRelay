use hx_catalog::Catalog;
use hx_proto::msgpack::Value as HxValue;
use hx_proto::rpc;
use hx_proto::ChannelId;
use hx_usb::Session;
use serde_json::{json, Value};

use crate::state::{knobs_json, routing_labels, slot_param, topology_from_preset};

const GLOBAL_IDS: [i64; 2] = [30, 134];

/// Front-panel changes drained from EVENTS between JSON requests.
#[derive(Default)]
pub struct FollowState {
    pub dirty: bool,
    pub setlist: Option<i64>,
    pub index: Option<i64>,
    pub name: Option<String>,
    /// Occupied IR slots from opcode 13. Cached for the USB session.
    pub irs: Option<Vec<(i64, String)>>,
}

impl FollowState {
    pub fn note(&mut self, notes: &[(i64, HxValue)]) {
        if !notes.is_empty() {
            self.dirty = true;
        }
    }

    fn remember(&mut self, setlist: i64, index: i64, name: Option<String>) {
        self.setlist = Some(setlist);
        self.index = Some(index);
        if let Some(name) = name {
            self.name = Some(name);
        }
    }
}

fn err(op: &str, message: impl ToString) -> Value {
    json!({"ok": false, "op": op, "error": message.to_string()})
}

fn parse_i64(v: Option<&Value>, lo: i64, hi: i64) -> Option<i64> {
    let n = v.and_then(Value::as_i64)?;
    (lo <= n && n <= hi).then_some(n)
}

fn usb_err(op: &str, e: hx_usb::Error) -> Value {
    let mut body = err(op, &e);
    if e.loses_session() {
        body["lost"] = json!(true);
    }
    body
}

pub fn handle(
    session: &mut Session,
    catalog: Option<&Catalog>,
    cmd: &Value,
    follow: &mut FollowState,
) -> Value {
    let Some(obj) = cmd.as_object() else {
        return json!({"ok": false, "error": "command must be an object with 'op'"});
    };
    let Some(op) = obj.get("op").and_then(Value::as_str) else {
        return json!({"ok": false, "error": "command must be an object with 'op'"});
    };

    match op {
        "ping" => json!({"ok": true, "op": op, "pong": true}),
        "info" => info(session, catalog, follow),
        "preset_info" => preset_info(session, follow),
        "list_presets" => list_presets(session, obj, follow),
        "select_preset" => select_preset(session, obj, follow),
        "select_snapshot" => select_snapshot(session, obj, follow),
        "events" => events(follow),
        "list_setlists" => list_setlists(session),
        "list_irs" => list_irs(session, follow),
        "move_block" => move_block(session, obj, follow),
        "set_model" => set_model(session, catalog, obj, follow),
        "clear_block" => clear_block(session, obj, follow),
        "save_preset" => save_preset(session, obj, follow),
        "set_param" => set_param(session, obj),
        "set_bool" => set_bool(session, obj),
        "set_int" => set_int(session, obj),
        "set_bypass" => set_bypass(session, obj),
        "set_trails" => set_trails(session, obj),
        "set_global" => set_global(session, obj),
        "set_assign" => set_assign(session, obj),
        "get_param" => get_param(session, catalog, obj),
        "get_assign" => get_assign(session, catalog, obj),
        "get_state" => get_state(session, catalog, follow),
        "list_models" => list_models(catalog),
        "topology" => topology(session, catalog),
        other => json!({"ok": false, "error": format!("unknown op: {other}")}),
    }
}

fn info(session: &mut Session, catalog: Option<&Catalog>, follow: &mut FollowState) -> Value {
    let _ = remember_info(session, follow);
    json!({
        "ok": true,
        "op": "info",
        "usb": true,
        "vid": format!("{:04x}", hx_proto::VENDOR_ID),
        "pid": format!("{:04x}", session.profile.product_id),
        "product": session.profile.name,
        "presets": session.profile.presets,
        "catalog": catalog.is_some(),
        "catalog_models": catalog.map(Catalog::len).unwrap_or(0),
        "setlist": follow.setlist,
        "index": follow.index,
        "name": follow.name,
        "ops": [
            "ping", "info", "preset_info", "list_presets", "select_preset",
            "select_snapshot", "events", "list_setlists", "list_irs", "move_block", "set_model",
            "clear_block", "save_preset",
            "set_param", "get_param", "get_state", "topology",
            "set_bool", "set_int", "set_bypass", "set_trails",
            "set_global", "set_assign", "get_assign", "list_models",
        ],
        "note": "TonePush hx-usb session; Helix Floor firmware 3.80",
    })
}

fn remember_info(session: &mut Session, follow: &mut FollowState) -> Option<(i64, i64, String)> {
    match session.preset_info() {
        Ok((setlist, index, name)) => {
            if setlist >= 0 {
                follow.remember(setlist, index, Some(name.clone()));
            }
            Some((setlist, index, name))
        }
        Err(_) => None,
    }
}

fn preset_info(session: &mut Session, follow: &mut FollowState) -> Value {
    match session.preset_info() {
        Ok((setlist, index, name)) => {
            follow.remember(setlist, index, Some(name.clone()));
            json!({
                "ok": true, "op": "preset_info",
                "setlist": setlist, "index": index, "name": name,
            })
        }
        Err(e) => usb_err("preset_info", e),
    }
}

fn events(follow: &mut FollowState) -> Value {
    let dirty = follow.dirty;
    follow.dirty = false;
    json!({
        "ok": true,
        "op": "events",
        "dirty": dirty,
        "setlist": follow.setlist,
        "index": follow.index,
    })
}

fn list_setlists(session: &mut Session) -> Value {
    match session.setlists() {
        Ok(names) => {
            let setlists: Vec<Value> = names
                .into_iter()
                .enumerate()
                .map(|(index, name)| json!({"index": index, "name": name}))
                .collect();
            json!({
                "ok": true,
                "op": "list_setlists",
                "count": setlists.len(),
                "setlists": setlists,
            })
        }
        Err(e) => usb_err("list_setlists", e),
    }
}

fn list_irs(session: &mut Session, follow: &mut FollowState) -> Value {
    match session.irs() {
        Ok(rows) => {
            let irs: Vec<Value> = rows
                .iter()
                .map(|(index, name)| json!({"index": index, "name": name}))
                .collect();
            follow.irs = Some(rows);
            json!({
                "ok": true,
                "op": "list_irs",
                "count": irs.len(),
                "irs": irs,
            })
        }
        Err(e) => usb_err("list_irs", e),
    }
}

fn list_presets(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let setlist = if obj.contains_key("setlist") {
        match parse_i64(obj.get("setlist"), 0, 7) {
            Some(n) => n,
            None => return err("list_presets", "setlist must be 0-7"),
        }
    } else {
        match session.preset_info() {
            Ok((sl, idx, _)) => {
                follow.remember(sl, idx, None);
                if (0..=7).contains(&sl) {
                    sl
                } else {
                    0
                }
            }
            Err(_) => 0,
        }
    };
    match session.presets(setlist) {
        Ok(names) => {
            let presets: Vec<Value> = names
                .into_iter()
                .enumerate()
                .map(|(index, name)| json!({"index": index, "name": name}))
                .collect();
            json!({
                "ok": true,
                "op": "list_presets",
                "setlist": setlist,
                "index": follow.index,
                "count": presets.len(),
                "presets": presets,
            })
        }
        Err(e) => usb_err("list_presets", e),
    }
}

fn select_preset(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let index = if let Some(i) = parse_i64(obj.get("index"), 0, 255) {
        i
    } else {
        let bank = match parse_i64(obj.get("bank"), 0, 255) {
            Some(b) => b,
            None => return err("select_preset", "bank and preset must be integers"),
        };
        let preset = match parse_i64(obj.get("preset"), 0, 255) {
            Some(p) => p,
            None => return err("select_preset", "bank and preset must be integers"),
        };
        bank * 16 + preset
    };
    let setlist = obj.get("setlist").and_then(Value::as_i64).unwrap_or(0);
    if !(0..=7).contains(&setlist) {
        return err("select_preset", "setlist must be 0-7");
    }
    match session.select_preset(setlist, index) {
        Ok(()) => {
            follow.remember(setlist, index, None);
            json!({"ok": true, "op": "select_preset", "setlist": setlist, "index": index})
        }
        Err(e) => usb_err("select_preset", e),
    }
}

fn select_snapshot(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let Some(index) = parse_i64(obj.get("index"), 0, 7) else {
        return err("select_snapshot", "index must be an integer 0-7");
    };
    match session.select_snapshot(index) {
        Ok(()) => {
            follow.dirty = true;
            json!({"ok": true, "op": "select_snapshot", "index": index})
        }
        Err(e) => usb_err("select_snapshot", e),
    }
}

/// Effect/empty slots only; Input/Output/Split/Join are fixtures.
pub fn move_allowed(from: i64, to: i64) -> Result<(), &'static str> {
    if !(0..=39).contains(&from) || !(0..=39).contains(&to) {
        return Err("from and to must be 0-39");
    }
    if from == to {
        return Err("from and to must differ");
    }
    if from / 20 != to / 20 {
        return Err("move must stay on one DSP path");
    }
    let local = |n: i64| n % 20;
    for slot in [from, to] {
        match local(slot) {
            0 | 9 | 10 | 19 => return Err("cannot move input, output, split, or merge"),
            _ => {}
        }
    }
    Ok(())
}

fn save_preset(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let (setlist, index, current_name) = match remember_info(session, follow) {
        Some(v) => v,
        None => return err("save_preset", "could not read current preset identity"),
    };
    let setlist = match obj.get("setlist") {
        None => setlist,
        Some(_) => match parse_i64(obj.get("setlist"), 0, 7) {
            Some(n) => n,
            None => return err("save_preset", "setlist must be 0-7"),
        },
    };
    let index = match obj.get("index") {
        None => index,
        Some(_) => match parse_i64(obj.get("index"), 0, 127) {
            Some(n) => n,
            None => return err("save_preset", "index must be an integer 0-127"),
        },
    };
    let name = match obj.get("name").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ if !current_name.is_empty() => current_name,
        _ => return err("save_preset", "name is required"),
    };
    match session.save_preset(setlist, index, &name) {
        Ok(()) => json!({
            "ok": true,
            "op": "save_preset",
            "setlist": setlist,
            "index": index,
            "name": name,
        }),
        Err(e) => usb_err("save_preset", e),
    }
}

fn move_block(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let Some(from) = parse_i64(obj.get("from"), 0, 39) else {
        return err("move_block", "from and to must be integers 0-39");
    };
    let Some(to) = parse_i64(obj.get("to"), 0, 39) else {
        return err("move_block", "from and to must be integers 0-39");
    };
    if let Err(message) = move_allowed(from, to) {
        return err("move_block", message);
    }
    match session.request(
        ChannelId::DATA,
        rpc::op::MOVE_BLOCK,
        hx_proto::msgmap! {
            rpc::key::MOVE_FROM => HxValue::Int(from),
            rpc::key::MOVE_TO => HxValue::Int(to),
        },
    ) {
        Ok(_) => {
            follow.dirty = true;
            json!({"ok": true, "op": "move_block", "from": from, "to": to})
        }
        Err(e) => usb_err("move_block", e),
    }
}

fn fixture_slot(block: i64) -> bool {
    matches!(block.rem_euclid(20), 0 | 9 | 10 | 19)
}

fn wire_for_id(catalog: &Catalog, id: &str, stereo: Option<bool>) -> Option<u32> {
    let cands: Vec<_> = catalog
        .symbols()
        .iter()
        .filter(|s| s.model.as_deref() == Some(id) || s.symbol == id)
        .collect();
    if cands.is_empty() {
        return None;
    }
    if let Some(want) = stereo {
        if let Some(s) = cands.iter().find(|s| s.symbol.ends_with("Stereo") == want) {
            return Some(s.number);
        }
    }
    cands.into_iter().min_by_key(|s| s.number).map(|s| s.number)
}

fn resolve_wire(
    catalog: Option<&Catalog>,
    obj: &serde_json::Map<String, Value>,
    int_key: &str,
    id_key: &str,
    op: &str,
    stereo: Option<bool>,
) -> Result<u32, Value> {
    if obj.contains_key(int_key) {
        return parse_i64(obj.get(int_key), 0, 10_000)
            .map(|n| n as u32)
            .ok_or_else(|| err(op, format!("{int_key} must be an integer 0-10000")));
    }
    let Some(id) = obj
        .get(id_key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Err(err(
            op,
            format!("{int_key} (int) or {id_key} (string) required"),
        ));
    };
    let Some(catalog) = catalog else {
        return Err(err(op, format!("catalog required to resolve {id_key}")));
    };
    wire_for_id(catalog, id, stereo).ok_or_else(|| err(op, format!("unknown {id_key}: {id}")))
}

fn set_model(
    session: &mut Session,
    catalog: Option<&Catalog>,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let Some(block) = parse_i64(obj.get("block"), 0, 39) else {
        return err("set_model", "block must be an integer 0-39");
    };
    if fixture_slot(block) {
        return err("set_model", "cannot change input, output, split, or merge");
    }
    let stereo = obj.get("stereo").and_then(Value::as_bool);
    let model = match resolve_wire(catalog, obj, "model", "model_id", "set_model", stereo) {
        Ok(n) => n,
        Err(e) => return e,
    };
    let pair_flag = obj.get("pair").and_then(Value::as_bool).unwrap_or(false);
    let paired = if obj.contains_key("paired") || obj.contains_key("paired_id") {
        match resolve_wire(catalog, obj, "paired", "paired_id", "set_model", None) {
            Ok(n) => Some(n),
            Err(e) => return e,
        }
    } else if pair_flag {
        let Some(catalog) = catalog else {
            return err("set_model", "catalog required for pair:true");
        };
        let Some(amp) = catalog.model_number(model) else {
            return err("set_model", "unknown amp model for pair:true");
        };
        let Some(cab) = catalog.paired_cab(amp) else {
            return err("set_model", "that amp has no Amp+Cab pair");
        };
        match wire_for_id(catalog, &cab.id, None) {
            Some(n) => Some(n),
            None => return err("set_model", "Amp+Cab cab has no wire number"),
        }
    } else {
        None
    };
    let result = match paired {
        Some(cab) => session.set_model_pair(block, model, cab),
        None => session.set_model(block, model),
    };
    match result {
        Ok(()) => {
            follow.dirty = true;
            let mut body = json!({
                "ok": true,
                "op": "set_model",
                "block": block,
                "model": model,
            });
            if let Some(cab) = paired {
                body["paired"] = json!(cab);
            }
            body
        }
        Err(e) => usb_err("set_model", e),
    }
}

fn clear_block(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let Some(block) = parse_i64(obj.get("block"), 0, 39) else {
        return err("clear_block", "block must be an integer 0-39");
    };
    if fixture_slot(block) {
        return err("clear_block", "cannot clear input, output, split, or merge");
    }
    match session.clear_block(block) {
        Ok(()) => {
            follow.dirty = true;
            json!({"ok": true, "op": "clear_block", "block": block})
        }
        Err(e) => usb_err("clear_block", e),
    }
}

fn block_param(obj: &serde_json::Map<String, Value>, op: &str) -> Result<(i64, i64, i64), Value> {
    let block = parse_i64(obj.get("block"), 0, 39)
        .ok_or_else(|| err(op, "block 0-39, param 0-31, subslot 0-1 required"))?;
    let param = parse_i64(obj.get("param"), 0, 31)
        .ok_or_else(|| err(op, "block 0-39, param 0-31, subslot 0-1 required"))?;
    let subslot = obj.get("subslot").and_then(Value::as_i64).unwrap_or(0);
    if !(0..=1).contains(&subslot) {
        return Err(err(op, "block 0-39, param 0-31, subslot 0-1 required"));
    }
    Ok((block, param, subslot))
}

fn write_param(
    session: &mut Session,
    block: i64,
    param: i64,
    path: i64,
    value: HxValue,
    commit: bool,
) -> Result<(), hx_usb::Error> {
    session.request(
        ChannelId::DATA,
        rpc::op::SET_PARAM,
        hx_proto::msgmap! {
            rpc::key::BLOCK => HxValue::Int(block),
            rpc::key::COMMIT => HxValue::Bool(commit),
            rpc::key::PATH => HxValue::Int(path),
            rpc::key::PARAM_INDEX => HxValue::Int(param),
            rpc::key::VALUE => value,
        },
    )?;
    Ok(())
}

fn set_param(session: &mut Session, obj: &serde_json::Map<String, Value>) -> Value {
    let (block, param, subslot) = match block_param(obj, "set_param") {
        Ok(v) => v,
        Err(e) => return e,
    };
    let Some(wire) = obj.get("float").and_then(Value::as_f64) else {
        return err("set_param", "float must be a number");
    };
    if !wire.is_finite() {
        return err("set_param", "float must be finite");
    }
    match write_param(
        session,
        block,
        param,
        subslot,
        HxValue::F32(wire as f32),
        true,
    ) {
        Ok(()) => json!({
            "ok": true, "op": "set_param",
            "block": block, "param": param, "subslot": subslot, "float": wire,
        }),
        Err(e) => usb_err("set_param", e),
    }
}

fn set_bool(session: &mut Session, obj: &serde_json::Map<String, Value>) -> Value {
    let (block, param, subslot) = match block_param(obj, "set_bool") {
        Ok(v) => v,
        Err(e) => return e,
    };
    let Some(value) = obj.get("value").and_then(Value::as_bool) else {
        return err("set_bool", "value must be true or false");
    };
    match write_param(session, block, param, subslot, HxValue::Bool(value), true) {
        Ok(()) => json!({
            "ok": true, "op": "set_bool",
            "block": block, "param": param, "subslot": subslot, "value": value,
        }),
        Err(e) => usb_err("set_bool", e),
    }
}

fn set_int(session: &mut Session, obj: &serde_json::Map<String, Value>) -> Value {
    let (block, param, subslot) = match block_param(obj, "set_int") {
        Ok(v) => v,
        Err(e) => return e,
    };
    let Some(value) = parse_i64(obj.get("value"), 0, 127) else {
        return err("set_int", "value must be an integer 0-127");
    };
    match write_param(session, block, param, subslot, HxValue::Int(value), true) {
        Ok(()) => json!({
            "ok": true, "op": "set_int",
            "block": block, "param": param, "subslot": subslot, "value": value,
        }),
        Err(e) => usb_err("set_int", e),
    }
}

fn set_bypass(session: &mut Session, obj: &serde_json::Map<String, Value>) -> Value {
    let Some(block) = parse_i64(obj.get("block"), 0, 39) else {
        return err("set_bypass", "block must be an integer 0-39");
    };
    let Some(enabled) = obj.get("enabled").and_then(Value::as_bool) else {
        return err("set_bypass", "enabled must be true or false");
    };
    match session.set_enabled(block, enabled) {
        Ok(()) => json!({"ok": true, "op": "set_bypass", "block": block, "enabled": enabled}),
        Err(e) => usb_err("set_bypass", e),
    }
}

fn set_trails(session: &mut Session, obj: &serde_json::Map<String, Value>) -> Value {
    let Some(block) = parse_i64(obj.get("block"), 0, 39) else {
        return err("set_trails", "block must be an integer 0-39");
    };
    let Some(value) = obj.get("value").and_then(Value::as_bool) else {
        return err("set_trails", "value must be true or false");
    };
    // Live Floor: type-30 with key 29 (COMMIT) false is Trails, not a knob write.
    match write_param(session, block, 0, 0, HxValue::Bool(value), false) {
        Ok(()) => json!({"ok": true, "op": "set_trails", "block": block, "value": value}),
        Err(e) => usb_err("set_trails", e),
    }
}

fn set_global(session: &mut Session, obj: &serde_json::Map<String, Value>) -> Value {
    let Some(id) = parse_i64(obj.get("id"), 0, 255) else {
        return err("set_global", "id and value must be integers");
    };
    let Some(value) = parse_i64(obj.get("value"), 0, 127) else {
        return err("set_global", "id and value must be integers");
    };
    if !GLOBAL_IDS.contains(&id) {
        return err(
            "set_global",
            "id not in live global allowlist (30=In-Z, 134=Pad)",
        );
    }
    match session.set_object(id, HxValue::Int(value)) {
        Ok(()) => json!({"ok": true, "op": "set_global", "id": id, "value": value}),
        Err(e) => usb_err("set_global", e),
    }
}

fn set_assign(session: &mut Session, obj: &serde_json::Map<String, Value>) -> Value {
    let Some(block) = parse_i64(obj.get("block"), 0, 39) else {
        return err("set_assign", "block and value must be integers");
    };
    let Some(value) = parse_i64(obj.get("value"), 0, 127) else {
        return err("set_assign", "block and value must be integers");
    };
    match session.set_routing(block, value) {
        Ok(()) => json!({"ok": true, "op": "set_assign", "block": block, "value": value}),
        Err(e) => usb_err("set_assign", e),
    }
}

fn get_param(
    session: &mut Session,
    catalog: Option<&Catalog>,
    obj: &serde_json::Map<String, Value>,
) -> Value {
    let (block, param, subslot) = match block_param(obj, "get_param") {
        Ok(v) => v,
        Err(e) => return e,
    };
    match session.read_preset() {
        Ok(preset) => match slot_param(&preset, block as usize, subslot as u8, param as usize) {
            Some(value) => {
                let mut body = json!({
                    "ok": true, "op": "get_param",
                    "block": block, "param": param, "subslot": subslot, "value": value,
                });
                if let Some(catalog) = catalog {
                    if let Some(slot) = preset.slots.get(block as usize) {
                        let (model, values) = if subslot == 1 {
                            (slot.paired, slot.paired_values.as_slice())
                        } else {
                            (slot.model, slot.values.as_slice())
                        };
                        if let Some(n) = model {
                            if let Some(knob) = knobs_json(catalog, n, values)
                                .into_iter()
                                .nth(param as usize)
                            {
                                body["name"] = knob["name"].clone();
                                body["min"] = knob["min"].clone();
                                body["max"] = knob["max"].clone();
                                body["kind"] = knob["kind"].clone();
                                body["usb"] = knob["usb"].clone();
                                if let Some(label) = knob.get("label") {
                                    body["label"] = label.clone();
                                }
                                if let Some(choices) = knob.get("choices") {
                                    body["choices"] = choices.clone();
                                }
                            }
                        }
                    }
                }
                body
            }
            None => err("get_param", "parameter missing in preset document"),
        },
        Err(e) => usb_err("get_param", e),
    }
}

fn get_assign(
    session: &mut Session,
    catalog: Option<&Catalog>,
    obj: &serde_json::Map<String, Value>,
) -> Value {
    let Some(block) = parse_i64(obj.get("block"), 0, 39) else {
        return err("get_assign", "block 0-39 and subslot 0-1 required");
    };
    match session.read_preset() {
        Ok(preset) => match preset.routing(block as usize) {
            Some(value) => {
                let mut body = json!({
                    "ok": true, "op": "get_assign",
                    "block": block, "subslot": 0, "value": value,
                });
                let kind = preset.slots.get(block as usize).map(|s| s.kind);
                if let Some(kind) = kind {
                    if let Some((label, menu)) = routing_labels(catalog, kind, value) {
                        body["label"] = json!(label);
                        body["menu"] = json!(menu);
                    }
                }
                body
            }
            None => err("get_assign", "slot has no assign field"),
        },
        Err(e) => usb_err("get_assign", e),
    }
}

fn pick_models(catalog: &Catalog, ids: &[String], pair_cab: bool) -> Vec<Value> {
    ids.iter()
        .filter_map(|id| {
            catalog.model(id).map(|m| {
                let mut load = m.dsp_load(false);
                let mut load_stereo = m.dsp_load(true);
                if pair_cab {
                    if let Some(cab) = catalog.paired_cab(m) {
                        load += cab.dsp_load(false);
                        load_stereo += cab.dsp_load(false);
                    }
                }
                let mut row = json!({
                    "id": m.id,
                    "name": m.name,
                });
                if load > 0.0 {
                    row["load"] = json!(load);
                }
                if load_stereo > 0.0 && (load_stereo - load).abs() > f32::EPSILON {
                    row["load_stereo"] = json!(load_stereo);
                }
                row
            })
        })
        .collect()
}

fn list_models(catalog: Option<&Catalog>) -> Value {
    let Some(catalog) = catalog else {
        return err("list_models", "catalog missing");
    };
    let categories: Vec<Value> = catalog
        .categories()
        .iter()
        .filter(|c| c.is_effect())
        .filter(|c| !c.models.is_empty() || c.subcategories.iter().any(|s| !s.models.is_empty()))
        .map(|c| {
            let shelves: Vec<Value> = c
                .subcategories
                .iter()
                .filter(|s| !s.models.is_empty())
                .map(|s| {
                    json!({
                        "name": s.name,
                        "models": pick_models(catalog, &s.models, c.paired),
                    })
                })
                .collect();
            json!({
                "id": c.id,
                "name": c.name,
                "short_name": c.short_name,
                "colour": format!("#{:06x}", c.colour & 0x00ff_ffff),
                "paired": c.paired,
                "models": pick_models(catalog, &c.models, c.paired),
                "shelves": shelves,
            })
        })
        .collect();
    json!({
        "ok": true,
        "op": "list_models",
        "count": categories.len(),
        "categories": categories,
    })
}

fn get_state(session: &mut Session, catalog: Option<&Catalog>, follow: &mut FollowState) -> Value {
    match session.read_preset() {
        Ok(preset) => {
            if catalog.is_some() && follow.irs.is_none() {
                if let Ok(rows) = session.irs() {
                    follow.irs = Some(rows);
                }
            }
            let mut body = topology_from_preset(&preset, catalog, follow.irs.as_deref());
            body["ok"] = json!(true);
            body["op"] = json!("get_state");
            body["catalog"] = json!(catalog.is_some());
            if let Some((setlist, index, name)) = remember_info(session, follow) {
                body["setlist"] = json!(setlist);
                body["index"] = json!(index);
                body["name"] = json!(name);
            }
            body
        }
        Err(e) => usb_err("get_state", e),
    }
}

fn topology(session: &mut Session, catalog: Option<&Catalog>) -> Value {
    match session.read_preset() {
        Ok(preset) => {
            let mut body = topology_from_preset(&preset, catalog, None);
            body["ok"] = json!(true);
            body["op"] = json!("topology");
            body["catalog"] = json!(catalog.is_some());
            body
        }
        Err(e) => usb_err("topology", e),
    }
}

#[cfg(test)]
mod tests {
    use super::{list_models, move_allowed, wire_for_id};
    use hx_catalog::Catalog;
    use hx_proto::rpc;
    use std::path::Path;

    #[test]
    fn move_block_opcode_and_keys() {
        assert_eq!(rpc::op::MOVE_BLOCK, 43);
        assert_eq!(rpc::key::MOVE_FROM, 75);
        assert_eq!(rpc::key::MOVE_TO, 76);
    }

    #[test]
    fn save_preset_opcode_and_keys() {
        assert_eq!(rpc::op::SAVE_PRESET, 71);
        assert_eq!(rpc::key::SETLIST, 107);
        assert_eq!(rpc::key::PRESET_INDEX, 108);
        assert_eq!(rpc::key::NAME, 109);
    }

    #[test]
    fn set_model_opcode_and_keys() {
        assert_eq!(rpc::op::SET_MODEL, 40);
        assert_eq!(rpc::op::CLEAR_BLOCK, 28);
        assert_eq!(rpc::op::SELECT_BLOCK, 78);
        assert_eq!(rpc::key::BLOCK, 98);
        assert_eq!(rpc::key::MODEL_REF, 100);
        assert_eq!(rpc::key::PAIRED, 23);
        assert_eq!(rpc::key::MODEL, 25);
        assert_eq!(rpc::key::PAIRED_MODEL, 26);
    }

    #[test]
    fn list_setlists_opcode() {
        assert_eq!(rpc::op::LIST_SETLISTS, 0);
    }

    #[test]
    fn list_irs_opcode_and_keys() {
        assert_eq!(rpc::op::LIST_IRS, 13);
        assert_eq!(rpc::key::IR_SLOT, 112);
        assert_eq!(rpc::key::NAME, 109);
        assert_eq!(rpc::key::ARGS, 101);
    }

    #[test]
    fn usb_err_marks_transport_loss() {
        let lost = super::usb_err(
            "get_state",
            hx_usb::Error::Usb("device disconnected".into()),
        );
        assert_eq!(lost["lost"], true);
        let refused = super::usb_err("set_model", hx_usb::Error::Device(-306));
        assert_ne!(refused.get("lost"), Some(&serde_json::json!(true)));
    }

    #[test]
    fn move_rejects_fixtures_and_cross_dsp() {
        assert!(move_allowed(7, 8).is_ok());
        assert!(move_allowed(7, 17).is_ok());
        assert!(move_allowed(21, 22).is_ok());
        assert!(move_allowed(7, 21).is_err());
        assert!(move_allowed(0, 1).is_err());
        assert!(move_allowed(7, 9).is_err());
        assert!(move_allowed(7, 10).is_err());
        assert!(move_allowed(21, 29).is_err());
        assert!(move_allowed(8, 8).is_err());
    }

    #[test]
    fn list_models_skips_io_and_lists_distortion() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources");
        let Ok(catalog) = Catalog::load_from(&dir) else {
            return;
        };
        let body = list_models(Some(&catalog));
        assert_eq!(body["ok"], true);
        let cats = body["categories"].as_array().expect("categories");
        assert!(cats.iter().any(|c| c["name"] == "Distortion"));
        assert!(cats.iter().any(|c| c["paired"] == true));
        assert!(cats
            .iter()
            .all(|c| c["name"] != "Input" && c["name"] != "Output"));
        assert!(cats.iter().all(|c| c["name"] != "Favorites"));
        assert!(cats.iter().all(|c| {
            let models = c["models"].as_array().map(|a| a.len()).unwrap_or(0);
            let shelves = c["shelves"].as_array().map(|a| a.len()).unwrap_or(0);
            models > 0 || shelves > 0
        }));
        let dist = cats
            .iter()
            .find(|c| c["name"] == "Distortion")
            .expect("Distortion");
        assert!(dist["models"]
            .as_array()
            .expect("models")
            .iter()
            .any(|m| m["name"] == "Kinky Boost" && m["load"].as_f64().unwrap_or(0.0) > 0.0));
    }

    #[test]
    fn wire_for_id_honours_stereo_flag() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources");
        let Ok(catalog) = Catalog::load_from(&dir) else {
            return;
        };
        let stereo_sym = catalog
            .symbols()
            .iter()
            .find(|s| s.symbol.ends_with("Stereo") && s.model.is_some())
            .expect("a Stereo firmware symbol");
        let id = stereo_sym.model.as_deref().unwrap();
        let stereo_n = wire_for_id(&catalog, id, Some(true)).expect("stereo wire");
        let mono_n = wire_for_id(&catalog, id, Some(false)).expect("mono wire");
        assert_ne!(stereo_n, mono_n);
        assert!(catalog.symbol(stereo_n).unwrap().symbol.ends_with("Stereo"));
        assert!(!catalog.symbol(mono_n).unwrap().symbol.ends_with("Stereo"));
    }
}
