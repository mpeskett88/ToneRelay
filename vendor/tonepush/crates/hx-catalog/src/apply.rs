//! Overlay the rest of a `.hlx` onto a native document: snapshots, controller
//! assignments, Command Centre.
//!
//! [`slots_from_hlx`](crate::slots_from_hlx) places the chain. This fills the
//! sections a template would otherwise keep from whoever was in the slot.
//! HX Edit stores parameter assignments under `tone.controller`, block
//! bypass / Instant labels under `tone.footswitch`, and per-snapshot knob
//! values under `snapshotN.controllers`. Native documents keep the first in
//! tone key 4 (array indexed by `@controller`), the second in tone key 3
//! field 8 (Command Centre cells, `@fs_index` is 1-based), and the third in
//! each snapshot's key 2.

use serde_json::Value as Json;

use hx_proto::msgpack::{Key, Value};
use hx_proto::Preset;

use crate::Catalog;

/// One chain block after it has been pasted, so snapshot and assignment
/// JSON can name it the way HX Edit does (`dsp0` / `block3`).
#[derive(Clone, Copy)]
pub struct Placement {
    pub dsp: usize,
    pub block: usize,
    pub slot: usize,
    pub model: u32,
}

struct Assign {
    dsp: usize,
    block: usize,
    param: usize,
    param_id: String,
    index: u64,
    slot: usize,
}

pub fn apply_hlx_rest(
    preset: &mut Preset,
    document: &Json,
    catalog: &Catalog,
    placements: &[Placement],
    skipped: &mut Vec<String>,
) {
    let Some(tone) = document.get("data").and_then(|d| d.get("tone")) else {
        return;
    };

    apply_tempo(preset, tone);
    let assigns = apply_controllers(preset, tone, catalog, placements, skipped);
    apply_footswitch(preset, tone, catalog, placements, skipped);
    apply_snapshots(preset, tone, placements, &assigns, skipped);
}

fn apply_tempo(preset: &mut Preset, tone: &Json) {
    let Some(tempo) = tone
        .get("global")
        .and_then(|g| g.get("@tempo"))
        .and_then(Json::as_f64)
    else {
        return;
    };
    let Some(slot) = preset.tone.at_mut(&[5, 16]) else {
        return;
    };
    set_f32(slot, tempo as f32);
}

fn apply_controllers(
    preset: &mut Preset,
    tone: &Json,
    catalog: &Catalog,
    placements: &[Placement],
    skipped: &mut Vec<String>,
) -> Vec<Assign> {
    let Some(controller) = tone.get("controller").and_then(Json::as_object) else {
        return Vec::new();
    };
    let n_sources = {
        let Some(Value::Array(by_source)) = preset.tone.get_mut(4) else {
            skipped.push("controller: the document has no assignment table".into());
            return Vec::new();
        };
        for slot in by_source.iter_mut() {
            *slot = Value::Nil;
        }
        by_source.len()
    };

    let mut found: Vec<(u64, Placement, usize, String, f32, f32, bool)> = Vec::new();
    for (dsp_name, dsp) in controller {
        let Some(dsp_index) = dsp_index(dsp_name) else {
            continue;
        };
        let Some(blocks) = dsp.as_object() else {
            continue;
        };
        for (block_key, params) in blocks {
            let Some(block_n) = block_index(block_key) else {
                continue;
            };
            let Some(place) = find_placement(placements, dsp_index, block_n) else {
                skipped.push(format!(
                    "controller.{dsp_name}.{block_key}: no block in the chain"
                ));
                continue;
            };
            let Some(params) = params.as_object() else {
                continue;
            };
            for (param_name, body) in params {
                let Some(source) = body.get("@controller").and_then(Json::as_u64) else {
                    continue;
                };
                if source == 0 {
                    continue;
                }
                let Some(param) = catalog.param_index(place.model, param_name) else {
                    skipped.push(format!(
                        "controller.{dsp_name}.{block_key}.{param_name}: unknown parameter"
                    ));
                    continue;
                };
                let min = body.get("@min").and_then(Json::as_f64).unwrap_or(0.0) as f32;
                let max = body.get("@max").and_then(Json::as_f64).unwrap_or(1.0) as f32;
                let snap_off = body
                    .get("@snapshot_disable")
                    .and_then(Json::as_bool)
                    .unwrap_or(false);
                found.push((source, place, param, param_name.clone(), min, max, snap_off));
            }
        }
    }

    let mut assigns = Vec::new();
    // Re-borrow after the scan: the scan used `by_source` then we dropped it
    // by ending the previous block. Fetch again.
    let Some(Value::Array(by_source)) = preset.tone.get_mut(4) else {
        return Vec::new();
    };
    for (table, (source, place, param, param_id, min, max, snap_off)) in
        found.into_iter().enumerate()
    {
        let ordinal = source as usize;
        if ordinal >= n_sources {
            skipped.push(format!(
                "controller @controller {source}: assignment table only has {n_sources} sources"
            ));
            continue;
        }
        let entry = param_assignment(
            source,
            table as u64,
            place.slot as u64,
            param as u64,
            min,
            max,
            snap_off,
        );
        match &mut by_source[ordinal] {
            Value::Nil => by_source[ordinal] = Value::Array(vec![entry]),
            Value::Array(items) => items.push(entry),
            other => *other = Value::Array(vec![entry]),
        }
        assigns.push(Assign {
            dsp: place.dsp,
            block: place.block,
            param,
            param_id,
            index: table as u64,
            slot: place.slot,
        });
    }
    assigns
}

fn apply_footswitch(
    preset: &mut Preset,
    tone: &Json,
    catalog: &Catalog,
    placements: &[Placement],
    skipped: &mut Vec<String>,
) {
    let footswitch = tone.get("footswitch").and_then(Json::as_object);
    if footswitch.is_none() && !controller_has_fs_index(tone) {
        return;
    }
    let n_cells = {
        let Some(Value::Array(cells)) = preset.tone.get_mut(3).and_then(|cc| cc.get_mut(8)) else {
            skipped.push("footswitch: the document has no Command Centre table".into());
            return;
        };
        for cell in cells.iter_mut() {
            *cell = Value::Nil;
        }
        cells.len()
    };

    let mut by_cell: Vec<Vec<Value>> = vec![Vec::new(); n_cells];
    if let Some(footswitch) = footswitch {
        for (dsp_name, dsp) in footswitch {
            let Some(dsp_index) = dsp_index(dsp_name) else {
                continue;
            };
            let Some(blocks) = dsp.as_object() else {
                continue;
            };
            for (block_key, body) in blocks {
                let Some(block_n) = block_index(block_key) else {
                    continue;
                };
                let Some(place) = find_placement(placements, dsp_index, block_n) else {
                    skipped.push(format!(
                        "footswitch.{dsp_name}.{block_key}: no block in the chain"
                    ));
                    continue;
                };
                if let Some(entry) = cc_from_json(
                    body,
                    place,
                    catalog,
                    None,
                    &by_cell,
                    skipped,
                    &format!("footswitch.{dsp_name}.{block_key}"),
                ) {
                    let cell = entry.0;
                    by_cell[cell].push(entry.1);
                }
            }
        }
    }
    if let Some(controller) = tone.get("controller").and_then(Json::as_object) {
        for (dsp_name, dsp) in controller {
            let Some(dsp_index) = dsp_index(dsp_name) else {
                continue;
            };
            let Some(blocks) = dsp.as_object() else {
                continue;
            };
            for (block_key, params) in blocks {
                let Some(block_n) = block_index(block_key) else {
                    continue;
                };
                let Some(place) = find_placement(placements, dsp_index, block_n) else {
                    continue;
                };
                let Some(params) = params.as_object() else {
                    continue;
                };
                for (param_name, body) in params {
                    if body.get("@fs_index").is_none() {
                        continue;
                    }
                    let Some(param) = catalog.param_index(place.model, param_name) else {
                        continue;
                    };
                    if let Some(entry) = cc_from_json(
                        body,
                        place,
                        catalog,
                        Some((param_name.as_str(), param)),
                        &by_cell,
                        skipped,
                        &format!("controller.{dsp_name}.{block_key}.{param_name}"),
                    ) {
                        let cell = entry.0;
                        by_cell[cell].push(entry.1);
                    }
                }
            }
        }
    }

    let Some(Value::Array(cells)) = preset.tone.get_mut(3).and_then(|cc| cc.get_mut(8)) else {
        return;
    };
    for (i, entries) in by_cell.into_iter().enumerate() {
        if !entries.is_empty() {
            cells[i] = Value::Array(entries);
        }
    }
}

fn controller_has_fs_index(tone: &Json) -> bool {
    let Some(controller) = tone.get("controller").and_then(Json::as_object) else {
        return false;
    };
    controller.values().any(|dsp| {
        dsp.as_object().is_some_and(|blocks| {
            blocks.values().any(|params| {
                params.as_object().is_some_and(|p| {
                    p.values()
                        .any(|body| body.get("@fs_index").and_then(Json::as_u64).unwrap_or(0) > 0)
                })
            })
        })
    })
}

fn cc_from_json(
    body: &Json,
    place: Placement,
    catalog: &Catalog,
    param: Option<(&str, usize)>,
    by_cell: &[Vec<Value>],
    skipped: &mut Vec<String>,
    where_: &str,
) -> Option<(usize, Value)> {
    let index = body.get("@fs_index").and_then(Json::as_u64)?;
    if index == 0 {
        return None;
    }
    let cell = (index as usize).saturating_sub(1);
    if cell >= by_cell.len() {
        skipped.push(format!(
            "{where_}: @fs_index {index} is outside this device"
        ));
        return None;
    }
    let model_name = catalog
        .model_number(place.model)
        .map(|m| m.name.clone())
        .unwrap_or_else(|| format!("block{}", place.block));
    let label = body
        .get("@fs_customlabel")
        .and_then(Json::as_str)
        .or_else(|| body.get("@fs_label").and_then(Json::as_str))
        .unwrap_or(&model_name);
    let colour = body.get("@fs_ledcolor").and_then(Json::as_u64).unwrap_or(0);
    let led_index = body.get("@fs_ledindex").and_then(Json::as_u64).unwrap_or(0);
    let place_in_cell = by_cell[cell].len() as u64;
    let momentary = body
        .get("@fs_momentary")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let enabled = body
        .get("@fs_enabled")
        .and_then(Json::as_bool)
        .unwrap_or(true);
    let primary = body
        .get("@fs_primary")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let entry = match param {
        None => cc_bypass(
            place_in_cell,
            &model_name,
            colour,
            place.slot as u64,
            momentary,
            enabled,
            label,
            primary,
            led_index,
        ),
        Some((param_name, param_index)) => {
            let shown = catalog
                .param(place.model, param_index)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| param_name.to_owned());
            cc_param(
                place_in_cell,
                &shown,
                colour,
                place.slot as u64,
                param_index as u64,
                momentary,
                enabled,
                label,
                primary,
                led_index,
            )
        }
    };
    Some((cell, entry))
}

fn apply_snapshots(
    preset: &mut Preset,
    tone: &Json,
    placements: &[Placement],
    assigns: &[Assign],
    skipped: &mut Vec<String>,
) {
    let n = match preset.tone.get(10).and_then(|s| s.get(10)) {
        Some(Value::Array(entries)) => entries.len(),
        _ => return,
    };
    for index in 0..n {
        let Some(json) = tone.get(format!("snapshot{index}")) else {
            continue;
        };
        apply_one_snapshot(preset, index, json, placements, assigns, skipped);
    }
}

fn apply_one_snapshot(
    preset: &mut Preset,
    index: usize,
    json: &Json,
    placements: &[Placement],
    assigns: &[Assign],
    skipped: &mut Vec<String>,
) {
    if let Some(name) = json.get("@name").and_then(Json::as_str) {
        let _ = preset.set_snapshot_name(index, name);
    }
    {
        let Some(Value::Array(entries)) = preset.tone.at_mut(&[10, 10]) else {
            return;
        };
        let Some(entry) = entries.get_mut(index) else {
            skipped.push(format!(
                "snapshot{index}: the document has no such snapshot"
            ));
            return;
        };
        if let Some(valid) = json.get("@valid").and_then(Json::as_bool) {
            set_existing(entry, 0, Value::Bool(valid));
        }
        if let Some(named) = json.get("@custom_name").and_then(Json::as_bool) {
            set_existing(entry, 14, Value::Bool(named));
        }
        if let Some(tempo) = json.get("@tempo").and_then(Json::as_f64) {
            if let Some(slot) = entry.get_mut(5) {
                set_f32(slot, tempo as f32);
            }
        }
        if let Some(pedal) = json.get("@pedalstate").and_then(Json::as_u64) {
            set_existing(entry, 11, Value::UInt(pedal));
        }
        if let Some(led) = json.get("@ledcolor").and_then(Json::as_u64) {
            set_existing(entry, 12, Value::UInt(led));
        }

        if let Some(blocks) = json.get("blocks").and_then(Json::as_object) {
            for (dsp_name, dsp) in blocks {
                let Some(dsp_index) = dsp_index(dsp_name) else {
                    continue;
                };
                let Some(dsp) = dsp.as_object() else {
                    continue;
                };
                for (key, value) in dsp {
                    if key == "split" || key == "join" {
                        continue;
                    }
                    let Some(block_n) = block_index(key) else {
                        continue;
                    };
                    let Some(place) = find_placement(placements, dsp_index, block_n) else {
                        continue;
                    };
                    set_slot_enabled(entry, place.slot, json_enabled(value));
                }
            }
        }
    }

    if !assigns.is_empty() {
        rewrite_snapshot_controllers(preset, index, json, assigns);
    }
}

fn rewrite_snapshot_controllers(
    preset: &mut Preset,
    index: usize,
    json: &Json,
    assigns: &[Assign],
) {
    let values: Vec<(u64, bool, f32)> = assigns
        .iter()
        .map(|assign| {
            let (disable, value) = snapshot_controller_value(json, assign, preset);
            (assign.index, disable, value)
        })
        .collect();
    let Some(Value::Array(entries)) = preset.tone.at_mut(&[10, 10]) else {
        return;
    };
    let Some(entry) = entries.get_mut(index) else {
        return;
    };
    let n_rows = match entry.get(2) {
        Some(Value::Array(rows)) => rows.len(),
        _ => 64,
    };
    let mut rows = vec![empty_ctrl_row(); n_rows];
    for (idx, disable, value) in values {
        if (idx as usize) < n_rows {
            rows[idx as usize] = ctrl_row(idx, disable, value);
        }
    }
    set_existing(entry, 2, Value::Array(rows));
}

fn snapshot_controller_value(json: &Json, assign: &Assign, preset: &Preset) -> (bool, f32) {
    let live = preset
        .slots
        .get(assign.slot)
        .and_then(|s| s.values.get(assign.param).copied())
        .unwrap_or(0.0);
    let path = json
        .get("controllers")
        .and_then(|c| c.get(format!("dsp{}", assign.dsp)))
        .and_then(|d| d.get(format!("block{}", assign.block)))
        .and_then(|b| b.get(&assign.param_id));
    let Some(body) = path else {
        return (false, live);
    };
    let disable = body
        .get("@fs_enabled")
        .and_then(Json::as_bool)
        .or_else(|| body.get("@snapshot_disable").and_then(Json::as_bool))
        .unwrap_or(false);
    let value = body
        .get("@value")
        .and_then(Json::as_f64)
        .map(|v| v as f32)
        .unwrap_or(live);
    (disable, value)
}

fn set_slot_enabled(snapshot: &mut Value, slot: usize, on: bool) {
    let Some(Value::Array(slots)) = snapshot.get_mut(3) else {
        return;
    };
    let Some(Value::Array(pair)) = slots.get_mut(slot) else {
        return;
    };
    if pair.len() < 2 {
        pair.resize(2, Value::Nil);
    }
    pair[1] = Value::Bool(on);
}

fn set_existing(map: &mut Value, key: i64, value: Value) {
    if let Some(slot) = map.get_mut(key) {
        *slot = value;
    }
}

fn set_f32(slot: &mut Value, n: f32) {
    *slot = match slot {
        Value::F64(_) => Value::F64(n as f64),
        _ => Value::F32(n),
    };
}

fn json_enabled(value: &Json) -> bool {
    match value {
        Json::Bool(b) => *b,
        Json::Object(o) => o.get("@enabled").and_then(Json::as_bool).unwrap_or(true),
        _ => true,
    }
}

fn dsp_index(name: &str) -> Option<usize> {
    name.strip_prefix("dsp")?.parse().ok()
}

fn block_index(name: &str) -> Option<usize> {
    name.strip_prefix("block")?.parse().ok()
}

fn find_placement(placements: &[Placement], dsp: usize, block: usize) -> Option<Placement> {
    placements
        .iter()
        .copied()
        .find(|p| p.dsp == dsp && p.block == block)
}

fn param_assignment(
    source: u64,
    table: u64,
    block: u64,
    param: u64,
    min: f32,
    max: f32,
    snap_off: bool,
) -> Value {
    Value::Map(vec![
        (Key::Int(0), Value::UInt(table)),
        (
            Key::Int(1),
            Value::Map(vec![
                (Key::Int(0), Value::UInt(source)),
                (Key::Int(1), Value::UInt(4)),
                (Key::Int(2), Value::F32(min)),
                (Key::Int(3), Value::F32(max)),
                (Key::Int(4), Value::UInt(0)),
                (Key::Int(5), Value::UInt(block)),
                (
                    Key::Int(6),
                    Value::Map(vec![
                        (Key::Int(28), Value::UInt(0)),
                        (Key::Int(29), Value::UInt(param)),
                        (Key::Int(41), Value::Bool(false)),
                    ]),
                ),
                (Key::Int(7), Value::UInt(0)),
                (Key::Int(13), Value::Bool(snap_off)),
            ]),
        ),
    ])
}

#[allow(clippy::too_many_arguments)]
fn cc_param(
    place: u64,
    name: &str,
    colour: u64,
    block: u64,
    param: u64,
    momentary: bool,
    enabled: bool,
    label: &str,
    primary: bool,
    led_index: u64,
) -> Value {
    Value::Map(vec![
        (Key::Int(10), Value::UInt(place)),
        (
            Key::Int(11),
            Value::Map(vec![
                (Key::Int(0), Value::UInt(2)),
                (Key::Int(5), Value::Str(name.to_owned())),
                (Key::Int(6), rgb(colour)),
                (Key::Int(7), Value::Bool(false)),
                (Key::Int(8), Value::UInt(block)),
                (Key::Int(2), Value::UInt(0)),
                (
                    Key::Int(9),
                    Value::Map(vec![
                        (Key::Int(28), Value::UInt(0)),
                        (Key::Int(29), Value::UInt(param)),
                        (Key::Int(41), Value::Bool(false)),
                    ]),
                ),
            ]),
        ),
        (Key::Int(12), Value::Bool(momentary)),
        (Key::Int(13), Value::Bool(enabled)),
        (Key::Int(14), Value::Str(label.to_owned())),
        (Key::Int(15), Value::Bool(primary)),
        (Key::Int(16), Value::UInt(led_index)),
    ])
}

#[allow(clippy::too_many_arguments)]
fn cc_bypass(
    place: u64,
    name: &str,
    colour: u64,
    block: u64,
    momentary: bool,
    enabled: bool,
    label: &str,
    primary: bool,
    led_index: u64,
) -> Value {
    Value::Map(vec![
        (Key::Int(10), Value::UInt(place)),
        (
            Key::Int(11),
            Value::Map(vec![
                (Key::Int(0), Value::UInt(1)),
                (Key::Int(5), Value::Str(name.to_owned())),
                (Key::Int(6), rgb(colour)),
                (Key::Int(7), Value::Bool(false)),
                (Key::Int(8), Value::UInt(block)),
                (Key::Int(2), Value::UInt(0)),
            ]),
        ),
        (Key::Int(12), Value::Bool(momentary)),
        (Key::Int(13), Value::Bool(enabled)),
        (Key::Int(14), Value::Str(label.to_owned())),
        (Key::Int(15), Value::Bool(primary)),
        (Key::Int(16), Value::UInt(led_index)),
    ])
}

fn rgb(n: u64) -> Value {
    if n > 0xff {
        Value::Wide(n, 4)
    } else {
        Value::UInt(n)
    }
}

fn empty_ctrl_row() -> Value {
    Value::Array(vec![Value::Bool(false), Value::UInt(64), Value::Nil])
}

fn ctrl_row(index: u64, disable: bool, value: f32) -> Value {
    Value::Array(vec![
        Value::Bool(disable),
        Value::UInt(index),
        Value::F32(value),
    ])
}
