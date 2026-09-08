use hx_catalog::{empty_the_chain, slots_from_hlx, to_hlx, Catalog};
use hx_proto::msgpack::Value as HxValue;
use hx_proto::preset::Kind;
use hx_proto::rpc;
use hx_proto::ChannelId;
use hx_proto::Preset;
use hx_usb::Session;
use serde_json::{json, Map, Value};

use crate::state::{knobs_json, routing_labels, slot_param, topology_from_preset};

const GLOBAL_IDS: [i64; 2] = [30, 134];
const HLX_MAX_BYTES: usize = 2 * 1024 * 1024;
const FAVORITE_SLOTS: i64 = 128;
const FAVORITE_NAME_MAX: usize = 32;
const PRESET_NAME_MAX: usize = 16;
const FAV_RECORD: i64 = 64;
const FAV_BODY: i64 = 20;
const FAV_IDS: i64 = 24;
const FAV_BLOCK: i64 = 11;
const FAV_CAB: i64 = 12;
const FAV_SYM: i64 = 3;
const FAV_VALS: i64 = 4;

/// Front-panel changes drained from EVENTS between JSON requests.
#[derive(Default)]
pub struct FollowState {
    pub dirty: bool,
    pub setlist: Option<i64>,
    pub index: Option<i64>,
    pub name: Option<String>,
    /// Occupied IR slots from opcode 13. Cached for the USB session.
    pub irs: Option<Vec<(i64, String)>>,
    /// Device favourite list from opcode 112. Cached for the USB session.
    pub favorites: Option<Vec<hx_usb::FavouriteEntry>>,
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
        "list_favorites" => list_favorites(session, catalog, follow),
        "apply_favorite" => apply_favorite(session, obj, follow),
        "save_favorite" => save_favorite(session, obj, follow),
        "rename_favorite" => rename_favorite(session, obj, follow),
        "delete_favorite" => delete_favorite(session, obj, follow),
        "move_block" => move_block(session, obj, follow),
        "set_model" => set_model(session, catalog, obj, follow),
        "clear_block" => clear_block(session, obj, follow),
        "save_preset" => save_preset(session, obj, follow),
        "rename_preset" => rename_preset(session, obj, follow),
        "export_preset" => export_preset(session, catalog, obj),
        "import_preset" => import_preset(session, catalog, obj, follow),
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
            "select_snapshot", "events", "list_setlists", "list_irs", "list_favorites",
            "apply_favorite", "save_favorite", "rename_favorite", "delete_favorite",
            "move_block", "set_model",
            "clear_block", "save_preset", "rename_preset", "export_preset", "import_preset",
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

fn list_favorites(
    session: &mut Session,
    catalog: Option<&Catalog>,
    follow: &mut FollowState,
) -> Value {
    match session.favourites() {
        Ok(rows) => {
            follow.favorites = Some(rows.clone());
            let favorites: Vec<Value> = rows.iter().map(|e| favorite_row(catalog, e)).collect();
            json!({
                "ok": true,
                "op": "list_favorites",
                "count": favorites.len(),
                "favorites": favorites,
            })
        }
        Err(e) => usb_err("list_favorites", e),
    }
}

fn favorite_row(catalog: Option<&Catalog>, entry: &hx_usb::FavouriteEntry) -> Value {
    let mut row = json!({
        "index": entry.index,
        "name": entry.name,
        "model": entry.model,
    });
    if let Some(cab) = entry.paired_cab {
        row["paired"] = json!(cab);
    }
    let Some(catalog) = catalog else {
        return row;
    };
    if entry.model < 0 {
        return row;
    }
    let Some(model) = catalog.model_number(entry.model as u32) else {
        return row;
    };
    row["model_id"] = json!(model.id);
    row["model_name"] = json!(model.name);
    if let Some(cat) = catalog
        .category_of(&model.id)
        .and_then(|id| catalog.category(id))
    {
        row["category"] = json!(cat.name);
    }
    let mut load = model.dsp_load(model.stereo);
    let mut load_stereo = model.dsp_load(true);
    if let Some(cab_n) = entry.paired_cab {
        if cab_n >= 0 {
            if let Some(cab) = catalog.model_number(cab_n as u32) {
                row["paired_id"] = json!(cab.id);
                load += cab.dsp_load(false);
                load_stereo += cab.dsp_load(false);
            }
        }
    }
    if load > 0.0 {
        row["load"] = json!(load);
    }
    if load_stereo > 0.0 && (load_stereo - load).abs() > f32::EPSILON {
        row["load_stereo"] = json!(load_stereo);
    }
    row
}

fn apply_favorite(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let Some(block) = parse_i64(obj.get("block"), 0, 39) else {
        return err("apply_favorite", "block must be an integer 0-39");
    };
    if fixture_slot(block) {
        return err(
            "apply_favorite",
            "cannot change input, output, split, or merge",
        );
    }
    let Some(index) = parse_i64(obj.get("index"), 0, FAVORITE_SLOTS - 1) else {
        return err("apply_favorite", "index must be an integer 0-127");
    };
    let reply = match session.fetch_favourite(index) {
        Ok(v) => v,
        Err(e) => return usb_err("apply_favorite", e),
    };
    let record = reply.get(FAV_RECORD).unwrap_or(&reply);
    let Some((model, paired_cab)) = favorite_ids(record) else {
        return err("apply_favorite", "favourite record has no model");
    };
    let placed = match paired_cab {
        Some(cab) => session.set_model_pair(block, model as u32, cab as u32),
        None => session.set_model(block, model as u32),
    };
    if let Err(e) = placed {
        return usb_err("apply_favorite", e);
    }
    let (values, sym_values) = favorite_values(record, FAV_BLOCK).unwrap_or_default();
    if let Err(e) = write_favorite_values(session, block, 0, &values, sym_values) {
        return usb_err("apply_favorite", e);
    }
    if paired_cab.is_some() {
        let (cab_values, _) = favorite_values(record, FAV_CAB).unwrap_or_default();
        if let Err(e) = write_favorite_values(session, block, 1, &cab_values, cab_values.len()) {
            return usb_err("apply_favorite", e);
        }
    }
    follow.dirty = true;
    json!({
        "ok": true,
        "op": "apply_favorite",
        "block": block,
        "index": index,
        "model": model,
    })
}

fn save_favorite(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let Some(block) = parse_i64(obj.get("block"), 0, 39) else {
        return err("save_favorite", "block must be an integer 0-39");
    };
    if fixture_slot(block) {
        return err(
            "save_favorite",
            "cannot save input, output, split, or merge",
        );
    }
    let Some(name) = obj.get("name").and_then(Value::as_str).map(str::trim) else {
        return err("save_favorite", "name must be a non-empty string");
    };
    if name.is_empty() || name.len() > FAVORITE_NAME_MAX {
        return err("save_favorite", "name must be 1-32 characters");
    }
    let listed = match session.favourites() {
        Ok(rows) => rows,
        Err(e) => return usb_err("save_favorite", e),
    };
    let index = if obj.contains_key("index") {
        match parse_i64(obj.get("index"), 0, FAVORITE_SLOTS - 1) {
            Some(n) => n,
            None => return err("save_favorite", "index must be an integer 0-127"),
        }
    } else {
        let taken: Vec<i64> = listed.iter().map(|e| e.index).collect();
        match (0..FAVORITE_SLOTS).find(|i| !taken.contains(i)) {
            Some(n) => n,
            None => return err("save_favorite", "favorites is full"),
        }
    };
    if listed.iter().any(|e| e.index == index) {
        return err("save_favorite", "index is already in use");
    }
    if let Err(e) = session.save_favourite(block, index, name) {
        return usb_err("save_favorite", e);
    }
    follow.favorites = None;
    follow.dirty = true;
    json!({
        "ok": true,
        "op": "save_favorite",
        "block": block,
        "index": index,
        "name": name,
    })
}

fn rename_favorite(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let Some(index) = parse_i64(obj.get("index"), 0, FAVORITE_SLOTS - 1) else {
        return err("rename_favorite", "index must be an integer 0-127");
    };
    let Some(name) = obj.get("name").and_then(Value::as_str).map(str::trim) else {
        return err("rename_favorite", "name must be a non-empty string");
    };
    if name.is_empty() || name.len() > FAVORITE_NAME_MAX {
        return err("rename_favorite", "name must be 1-32 characters");
    }
    let listed = match session.favourites() {
        Ok(rows) => rows,
        Err(e) => return usb_err("rename_favorite", e),
    };
    if !listed.iter().any(|e| e.index == index) {
        return err("rename_favorite", "no favorite at that index");
    }
    if let Err(e) = session.rename_favourite(index, name) {
        return usb_err("rename_favorite", e);
    }
    follow.favorites = None;
    json!({
        "ok": true,
        "op": "rename_favorite",
        "index": index,
        "name": name,
    })
}

fn delete_favorite(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let Some(index) = parse_i64(obj.get("index"), 0, FAVORITE_SLOTS - 1) else {
        return err("delete_favorite", "index must be an integer 0-127");
    };
    let listed = match session.favourites() {
        Ok(rows) => rows,
        Err(e) => return usb_err("delete_favorite", e),
    };
    if !listed.iter().any(|e| e.index == index) {
        return err("delete_favorite", "no favorite at that index");
    }
    if let Err(e) = session.clear_favourite(index) {
        return usb_err("delete_favorite", e);
    }
    follow.favorites = None;
    json!({
        "ok": true,
        "op": "delete_favorite",
        "index": index,
    })
}

fn favorite_ids(record: &HxValue) -> Option<(i64, Option<i64>)> {
    let ids = record.get(FAV_BODY)?.get(FAV_IDS)?;
    let model = ids.get(rpc::key::MODEL)?.as_i64()?;
    if model < 0 {
        return None;
    }
    let cab = ids.get(rpc::key::PAIRED_MODEL).and_then(HxValue::as_i64);
    let paired = match cab {
        Some(n) if n >= 0 && n != 65535 => Some(n),
        _ => None,
    };
    Some((model, paired))
}

fn favorite_values(record: &HxValue, key: i64) -> Option<(Vec<HxValue>, usize)> {
    let list = record.get(FAV_BODY)?.get(key)?;
    let sym = list.get(FAV_SYM).and_then(HxValue::as_i64).unwrap_or(0) as usize;
    let HxValue::Array(vals) = list.get(FAV_VALS)? else {
        return None;
    };
    Some((vals.clone(), sym))
}

fn favorite_wire(v: &HxValue) -> Option<HxValue> {
    match v {
        HxValue::Bool(b) => Some(HxValue::Bool(*b)),
        HxValue::Int(i) | HxValue::WideInt(i, _) => Some(HxValue::Int(*i)),
        HxValue::UInt(u) | HxValue::Wide(u, _) => Some(HxValue::Int(i64::try_from(*u).ok()?)),
        HxValue::F32(f) => Some(HxValue::F32(*f)),
        HxValue::F64(f) => Some(HxValue::F32(*f as f32)),
        _ => None,
    }
}

fn write_favorite_values(
    session: &mut Session,
    block: i64,
    path: i64,
    values: &[HxValue],
    limit: usize,
) -> Result<(), hx_usb::Error> {
    for (i, v) in values.iter().take(limit).enumerate() {
        let Some(wire) = favorite_wire(v) else {
            continue;
        };
        write_param(session, block, i as i64, path, wire, true)?;
    }
    Ok(())
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

fn rename_preset(
    session: &mut Session,
    obj: &serde_json::Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let (setlist, index) = match parse_slot(obj, "rename_preset") {
        Ok(v) => v,
        Err(e) => return e,
    };
    let Some(name) = obj.get("name").and_then(Value::as_str).map(str::trim) else {
        return err("rename_preset", "name must be a non-empty string");
    };
    if name.is_empty() || name.len() > PRESET_NAME_MAX {
        return err("rename_preset", "name must be 1-16 characters");
    }
    if let Err(e) = session.rename_preset(setlist, index, name) {
        return usb_err("rename_preset", e);
    }
    if follow.setlist == Some(setlist) && follow.index == Some(index) {
        follow.name = Some(name.to_string());
    }
    json!({
        "ok": true,
        "op": "rename_preset",
        "setlist": setlist,
        "index": index,
        "name": name,
    })
}

fn catalog_required<'a>(op: &str, catalog: Option<&'a Catalog>) -> Result<&'a Catalog, Value> {
    catalog.ok_or_else(|| err(op, "HX Edit catalog required to import/export .hlx"))
}

fn parse_slot(obj: &Map<String, Value>, op: &str) -> Result<(i64, i64), Value> {
    let Some(setlist) = parse_i64(obj.get("setlist"), 0, 7) else {
        return Err(err(op, "setlist must be 0-7"));
    };
    let Some(index) = parse_i64(obj.get("index"), 0, 127) else {
        return Err(err(op, "index must be an integer 0-127"));
    };
    Ok((setlist, index))
}

fn json_bytes(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|b| b.len())
        .unwrap_or(usize::MAX)
}

fn slot_name(session: &mut Session, setlist: i64, index: i64) -> String {
    session
        .presets(setlist)
        .ok()
        .and_then(|names| names.get(index as usize).cloned())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "preset".into())
}

fn hlx_name(document: &Value) -> String {
    let raw = document
        .pointer("/data/meta/name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let name = if raw.is_empty() { "Imported" } else { raw };
    name.chars().take(32).collect()
}

fn hlx_filename(name: &str) -> String {
    let mut stem = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.') {
            stem.push(ch);
        }
    }
    let stem = stem.trim().trim_matches('.');
    let stem = if stem.is_empty() { "preset" } else { stem };
    let stem: String = stem.chars().take(80).collect();
    format!("{stem}.hlx")
}

fn rewrite_endpoint(dsp: &mut Map<String, Value>, key: &str, model: &str) {
    let Some(node) = dsp.get_mut(key).and_then(Value::as_object_mut) else {
        return;
    };
    let Some(Value::String(current)) = node.get_mut("@model") else {
        return;
    };
    if current.starts_with("HelixStomp_") {
        *current = model.to_string();
    }
}

/// TonePush `to_hlx` hard-codes HX Stomp I/O symbols. Floor files use HD2_*.
fn rewrite_floor_io(document: &mut Value) {
    let Some(tone) = document
        .pointer_mut("/data/tone")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    for (dsp_name, input, output) in [
        ("dsp0", "HD2_AppDSPFlow1Input", "HD2_AppDSPFlowOutput"),
        ("dsp1", "HD2_AppDSPFlow2Input", "HD2_AppDSPFlow2Output"),
    ] {
        let Some(dsp) = tone.get_mut(dsp_name).and_then(Value::as_object_mut) else {
            continue;
        };
        rewrite_endpoint(dsp, "inputA", input);
        rewrite_endpoint(dsp, "inputB", input);
        rewrite_endpoint(dsp, "outputA", output);
        rewrite_endpoint(dsp, "outputB", output);
    }
}

fn user_blocks(preset: &Preset) -> usize {
    preset
        .slots
        .iter()
        .filter(|s| matches!(s.kind, Kind::Block | Kind::Looper) && s.model.is_some())
        .count()
}

fn needed_usb_slots(hlx: &Value) -> Vec<usize> {
    let mut out = Vec::new();
    let Some(tone) = hlx.pointer("/data/tone").and_then(Value::as_object) else {
        return out;
    };
    // HX Edit files use @path/@position and omit @slot. Only dsp0/dsp1 are
    // chains; snapshot "blocks" maps would match a naive "block*" scan.
    for (dsp_name, fallback) in [("dsp0", 1usize), ("dsp1", 21usize)] {
        let Some(dsp) = tone.get(dsp_name).and_then(Value::as_object) else {
            continue;
        };
        for (key, block) in dsp {
            if !key.starts_with("block") || key == "blocks" {
                continue;
            }
            if let Some(slot) = block.get("@slot").and_then(Value::as_u64) {
                out.push(slot as usize);
            } else {
                out.push(fallback);
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn restore_slot(
    session: &mut Session,
    setlist: i64,
    index: i64,
    name: &str,
    backup: &Preset,
) -> Result<(), hx_usb::Error> {
    session.write_preset_at(setlist, index, name, backup)
}

fn maybe_restore(
    session: &mut Session,
    setlist: i64,
    index: i64,
    name: &str,
    backup: Option<&[u8]>,
) {
    let Some(bytes) = backup else {
        return;
    };
    let Some(prev) = Preset::parse(bytes) else {
        return;
    };
    let _ = restore_slot(session, setlist, index, name, &prev);
}

fn drain_session(session: &mut Session, follow: &mut FollowState) {
    for _ in 0..12 {
        follow.note(&session.poll_notifications());
        let _ = session.keepalive();
    }
}

fn recover_import(
    session: &mut Session,
    setlist: i64,
    index: i64,
    name: &str,
    backup: Option<&[u8]>,
) {
    if backup.is_some() {
        maybe_restore(session, setlist, index, name, backup);
        return;
    }
    let _ = session.clear_preset_at(setlist, index);
}

fn import_template(session: &mut Session, dest: Option<&Preset>) -> Result<Preset, Value> {
    let bytes = match dest {
        Some(preset) => preset.encode(),
        None => session
            .read_preset()
            .map_err(|e| usb_err("import_preset", e))?
            .encode(),
    };
    Preset::parse(&bytes)
        .ok_or_else(|| err("import_preset", "the template document does not re-parse"))
}

fn export_preset(
    session: &mut Session,
    catalog: Option<&Catalog>,
    obj: &Map<String, Value>,
) -> Value {
    let (setlist, index) = match parse_slot(obj, "export_preset") {
        Ok(v) => v,
        Err(e) => return e,
    };
    let catalog = match catalog_required("export_preset", catalog) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let name = slot_name(session, setlist, index);
    let preset = match session.read_preset_at(setlist, index) {
        Ok(Some(preset)) => preset,
        Ok(None) => match session.read_preset() {
            Ok(template) => {
                let Some(mut empty) = Preset::parse(&template.encode()) else {
                    return err("export_preset", "the loaded document does not re-parse");
                };
                empty_the_chain(&mut empty);
                empty
            }
            Err(e) => return usb_err("export_preset", e),
        },
        Err(e) => return usb_err("export_preset", e),
    };
    let mut written = to_hlx(&preset, catalog, &name);
    rewrite_floor_io(&mut written.document);
    if json_bytes(&written.document) > HLX_MAX_BYTES {
        return err("export_preset", "hlx is too large");
    }
    let mut body = json!({
        "ok": true,
        "op": "export_preset",
        "setlist": setlist,
        "index": index,
        "name": name,
        "filename": hlx_filename(&name),
        "hlx": written.document,
    });
    if !written.skipped.is_empty() {
        body["skipped"] = json!(written.skipped);
    }
    body
}

fn import_preset(
    session: &mut Session,
    catalog: Option<&Catalog>,
    obj: &Map<String, Value>,
    follow: &mut FollowState,
) -> Value {
    let (setlist, index) = match parse_slot(obj, "import_preset") {
        Ok(v) => v,
        Err(e) => return e,
    };
    let catalog = match catalog_required("import_preset", catalog) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let Some(hlx) = obj.get("hlx") else {
        return err("import_preset", "hlx must be a JSON object");
    };
    if !hlx.is_object() || hlx.pointer("/data/tone").is_none() {
        return err("import_preset", "hlx must have data.tone");
    }
    if json_bytes(hlx) > HLX_MAX_BYTES {
        return err("import_preset", "hlx is too large");
    }
    let name = hlx_name(hlx);
    let dest = match session.read_preset_at(setlist, index) {
        Ok(preset) => preset,
        Err(e) => return usb_err("import_preset", e),
    };
    let original_name = slot_name(session, setlist, index);
    let backup = dest.as_ref().map(Preset::encode);
    let loaded_before = remember_info(session, follow);
    let dest_was_loaded = loaded_before
        .as_ref()
        .is_some_and(|(s, i, _)| *s == setlist && *i == index);

    let mut template = match import_template(session, dest.as_ref()) {
        Ok(preset) => preset,
        Err(e) => return e,
    };
    empty_the_chain(&mut template);
    let built = slots_from_hlx(&mut template, hlx, catalog);
    if built.blocks == 0 && !needed_usb_slots(hlx).is_empty() {
        let mut body = err("import_preset", "nothing from the file could be placed");
        if !built.skipped.is_empty() {
            body["skipped"] = json!(built.skipped);
        }
        return body;
    }

    eprintln!("import_preset: write_preset_at {name} setlist {setlist} index {index}");
    if let Err(e) = session.write_preset_at(setlist, index, &name, &template) {
        if !e.loses_session() {
            recover_import(session, setlist, index, &original_name, backup.as_deref());
        }
        return usb_err("import_preset", e);
    }
    follow.dirty = true;
    if dest_was_loaded {
        follow.remember(setlist, index, Some(name.clone()));
    }
    drain_session(session, follow);

    let after = match session.read_preset_at(setlist, index) {
        Ok(preset) => preset,
        Err(e) => {
            if !e.loses_session() {
                recover_import(session, setlist, index, &original_name, backup.as_deref());
            }
            return usb_err("import_preset", e);
        }
    };
    let kept = after.as_ref().map(user_blocks).unwrap_or(0);
    if built.blocks > 0 && kept == 0 {
        recover_import(session, setlist, index, &original_name, backup.as_deref());
        return err(
            "import_preset",
            "the device did not keep the imported chain; original restored",
        );
    }

    // Opcode 8 writes flash. Reloading the playing slot is what makes the
    // Floor screen and get_state match; HX Edit's import onto the current
    // preset is followed by a document read, and leaving then returning is
    // the same redraw.
    if dest_was_loaded {
        if let Err(e) = session.select_preset(setlist, index) {
            eprintln!("import_preset: reload after write failed: {e}");
        } else {
            drain_session(session, follow);
        }
    }

    let mut body = json!({
        "ok": true,
        "op": "import_preset",
        "setlist": setlist,
        "index": index,
        "name": name,
        "blocks": built.blocks,
    });
    if !built.skipped.is_empty() {
        body["skipped"] = json!(built.skipped);
    }
    body
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
    let Some(value) = parse_i64(obj.get("value"), 0, 128) else {
        return err("set_int", "value must be an integer 0-128");
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
                                if let Some(format) = knob.get("format") {
                                    body["format"] = format.clone();
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
    fn rename_preset_opcode_and_keys() {
        assert_eq!(rpc::op::RENAME_PRESET, 6);
        assert_eq!(rpc::key::SETLIST, 107);
        assert_eq!(rpc::key::PRESET_INDEX, 108);
        assert_eq!(rpc::key::NAME, 109);
    }

    #[test]
    fn slot_transfer_opcodes() {
        assert_eq!(rpc::op::FETCH_PRESET, 4);
        assert_eq!(rpc::op::WRITE_SLOT_NAMED, 8);
        assert_eq!(rpc::key::DOCUMENT, 110);
    }

    #[test]
    fn needed_usb_slots_reads_dsp0_and_dsp1() {
        let hlx = serde_json::json!({
            "data": {
                "tone": {
                    "dsp0": {
                        "block0": { "@slot": 1, "@model": "HD2_DistKinkyBoost" },
                        "inputA": { "@model": "HD2_AppDSPFlow1Input" }
                    },
                    "dsp1": {
                        "block0": { "@slot": 23, "@model": "HD2_MM4Dimension" },
                        "block1": { "@slot": 24, "@model": "HD2_DelayTransistorTape" }
                    }
                }
            }
        });
        assert_eq!(super::needed_usb_slots(&hlx), vec![1, 23, 24]);
    }

    #[test]
    fn needed_usb_slots_hx_edit_without_at_slot() {
        let hlx = serde_json::json!({
            "data": {
                "tone": {
                    "dsp0": {
                        "block0": { "@path": 0, "@position": 0, "@model": "HD2_DistKinkyBoost" }
                    },
                    "dsp1": {
                        "block0": { "@path": 0, "@position": 2, "@model": "HD2_MM4Dimension" }
                    },
                    "snapshot0": {
                        "blocks": { "dsp0": { "block0": true } }
                    }
                }
            }
        });
        assert_eq!(super::needed_usb_slots(&hlx), vec![1, 21]);
    }

    #[test]
    fn hlx_filename_sanitises_and_falls_back() {
        assert_eq!(super::hlx_filename("Essex A30"), "Essex A30.hlx");
        assert_eq!(super::hlx_filename("../evil"), "evil.hlx");
        assert_eq!(super::hlx_filename("***"), "preset.hlx");
        assert_eq!(super::hlx_filename(""), "preset.hlx");
    }

    #[test]
    fn rewrite_floor_io_replaces_stomp_endpoints() {
        let mut document = serde_json::json!({
            "data": {
                "meta": { "name": "Probe" },
                "tone": {
                    "dsp0": {
                        "inputA": { "@model": "HelixStomp_AppDSPFlowInput" },
                        "outputA": { "@model": "HelixStomp_AppDSPFlowOutputMain" },
                        "outputB": { "@model": "HelixStomp_AppDSPFlowOutputSend" },
                        "block0": { "@model": "HD2_DistKinkyBoost" }
                    },
                    "dsp1": {
                        "inputA": { "@model": "HelixStomp_AppDSPFlowInput" },
                        "outputA": { "@model": "HelixStomp_AppDSPFlowOutputMain" }
                    }
                }
            }
        });
        super::rewrite_floor_io(&mut document);
        assert_eq!(
            document
                .pointer("/data/tone/dsp0/inputA/@model")
                .and_then(serde_json::Value::as_str),
            Some("HD2_AppDSPFlow1Input")
        );
        assert_eq!(
            document
                .pointer("/data/tone/dsp0/outputA/@model")
                .and_then(serde_json::Value::as_str),
            Some("HD2_AppDSPFlowOutput")
        );
        assert_eq!(
            document
                .pointer("/data/tone/dsp0/outputB/@model")
                .and_then(serde_json::Value::as_str),
            Some("HD2_AppDSPFlowOutput")
        );
        assert_eq!(
            document
                .pointer("/data/tone/dsp1/inputA/@model")
                .and_then(serde_json::Value::as_str),
            Some("HD2_AppDSPFlow2Input")
        );
        assert_eq!(
            document
                .pointer("/data/tone/dsp1/outputA/@model")
                .and_then(serde_json::Value::as_str),
            Some("HD2_AppDSPFlow2Output")
        );
        assert_eq!(
            document
                .pointer("/data/tone/dsp0/block0/@model")
                .and_then(serde_json::Value::as_str),
            Some("HD2_DistKinkyBoost")
        );
    }

    #[test]
    fn rewrite_floor_io_leaves_floor_ids() {
        let mut document = serde_json::json!({
            "data": { "tone": { "dsp0": { "inputA": { "@model": "HD2_AppDSPFlow1Input" } } } }
        });
        super::rewrite_floor_io(&mut document);
        assert_eq!(
            document
                .pointer("/data/tone/dsp0/inputA/@model")
                .and_then(serde_json::Value::as_str),
            Some("HD2_AppDSPFlow1Input")
        );
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
    fn favorites_opcodes_and_keys() {
        assert_eq!(rpc::op::LIST_FAVOURITES, 112);
        assert_eq!(rpc::op::FETCH_FAVOURITE, 113);
        assert_eq!(rpc::op::SAVE_FAVOURITE, 119);
        assert_eq!(rpc::key::FAVOURITE_MODEL, 64);
        assert_eq!(rpc::key::FAVOURITE_CAB, 105);
        assert_eq!(rpc::key::FAVOURITE_FLAG, 31);
        assert_eq!(rpc::key::OBJECT_ID, 118);
    }

    #[test]
    fn favorite_record_reads_model_cab_and_sym_values() {
        use super::{favorite_ids, favorite_values, favorite_wire, FAV_BLOCK, FAV_CAB};
        use hx_proto::msgpack::Value as HxValue;
        let record = hx_proto::msgmap! {
            20 => hx_proto::msgmap! {
                24 => hx_proto::msgmap! {
                    23 => HxValue::Bool(true),
                    25 => HxValue::Int(591),
                    26 => HxValue::Int(709),
                },
                11 => hx_proto::msgmap! {
                    2 => HxValue::Int(2),
                    3 => HxValue::Int(1),
                    4 => HxValue::Array(vec![HxValue::F32(0.41), HxValue::Bool(true)]),
                },
                12 => hx_proto::msgmap! {
                    2 => HxValue::Int(1),
                    3 => HxValue::Int(1),
                    4 => HxValue::Array(vec![HxValue::Int(2)]),
                },
            },
        };
        assert_eq!(favorite_ids(&record), Some((591, Some(709))));
        let (values, sym) = favorite_values(&record, FAV_BLOCK).expect("block values");
        assert_eq!(sym, 1);
        assert_eq!(values.len(), 2);
        assert!(matches!(favorite_wire(&values[0]), Some(HxValue::F32(_))));
        let (cab, cab_sym) = favorite_values(&record, FAV_CAB).expect("cab values");
        assert_eq!(cab_sym, 1);
        assert!(matches!(favorite_wire(&cab[0]), Some(HxValue::Int(2))));
    }

    #[test]
    fn favorite_ids_treats_missing_cab_as_none() {
        use super::favorite_ids;
        use hx_proto::msgpack::Value as HxValue;
        let record = hx_proto::msgmap! {
            20 => hx_proto::msgmap! {
                24 => hx_proto::msgmap! {
                    25 => HxValue::Int(636),
                    26 => HxValue::Int(-1),
                },
            },
        };
        assert_eq!(favorite_ids(&record), Some((636, None)));
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
