use hx_catalog::{Catalog, Kind as ParamKind};
use hx_proto::preset::{Kind, Layout, Preset};
use serde_json::{json, Value};

pub fn kind_num(kind: Kind) -> i64 {
    match kind {
        Kind::Input => 0,
        Kind::Output => 1,
        Kind::Split => 2,
        Kind::Join => 3,
        Kind::Block => 6,
        Kind::Looper => 7,
        Kind::Empty => 8,
        Kind::Unknown(n) => n,
    }
}

fn num(v: f32) -> Value {
    serde_json::Number::from_f64(f64::from(v))
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn params_json(values: &[f32]) -> Vec<Value> {
    values.iter().copied().map(num).collect()
}

fn kind_usb(kind: ParamKind) -> &'static str {
    match kind {
        ParamKind::Switch => "bool",
        ParamKind::Enum => "int",
        ParamKind::Continuous | ParamKind::Text => "f32",
    }
}

fn kind_name(kind: ParamKind) -> &'static str {
    match kind {
        ParamKind::Enum => "enum",
        ParamKind::Continuous => "continuous",
        ParamKind::Switch => "switch",
        ParamKind::Text => "text",
    }
}

/// Helix Floor IR library size. `HelixControls.json` `ir_select` is 128 dashes.
pub const IR_SLOTS: usize = 128;

fn is_ir_select(knob: &Value) -> bool {
    knob.get("display").and_then(Value::as_str) == Some("ir_select")
}

/// Menu labels for IR Select: 1-based slot, plus the device name when the slot is occupied.
pub fn ir_menu(irs: &[(i64, String)], slots: usize) -> Vec<String> {
    let n = slots.max(1);
    let mut labels: Vec<String> = (0..n).map(|i| format!("{}", i + 1)).collect();
    for (slot, name) in irs {
        if *slot < 0 {
            continue;
        }
        let i = *slot as usize;
        if i >= n {
            continue;
        }
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            labels[i] = format!("{}  {trimmed}", i + 1);
        }
    }
    labels
}

/// Replace catalog placeholder dashes on IR Select knobs with names from opcode 13.
pub fn overlay_ir_choices(knobs: &mut [Value], irs: &[(i64, String)], values: &[f32]) {
    for knob in knobs.iter_mut() {
        if !is_ir_select(knob) {
            continue;
        }
        let n = knob
            .get("choices")
            .and_then(Value::as_array)
            .map(|a| if a.is_empty() { IR_SLOTS } else { a.len() })
            .unwrap_or(IR_SLOTS);
        let labels = ir_menu(irs, n);
        if let Some(idx) = knob.get("index").and_then(Value::as_u64) {
            if let Some(v) = values.get(idx as usize) {
                let i = v.round().max(0.0) as usize;
                if let Some(label) = labels.get(i) {
                    knob["label"] = json!(label);
                }
            }
        }
        knob["choices"] = json!(labels);
    }
}

/// Names, ranges, and HX Edit labels for one USB model number.
pub fn knobs_json(catalog: &Catalog, model_number: u32, values: &[f32]) -> Vec<Value> {
    let Some(model) = catalog.model_number(model_number) else {
        return Vec::new();
    };
    catalog
        .ordered_params(model)
        .into_iter()
        .enumerate()
        .map(|(index, param)| {
            let mut knob = json!({
                "index": index,
                "id": param.id,
                "name": param.name,
                "kind": kind_name(param.kind),
                "usb": kind_usb(param.kind),
                "min": num(param.min),
                "max": num(param.max),
            });
            if let Some(display) = &param.display {
                knob["display"] = json!(display);
            }
            if let Some(choices) = catalog.choices(param) {
                knob["choices"] = json!(choices);
            }
            if let Some(v) = values.get(index).copied() {
                knob["label"] = json!(catalog.format(param, v));
            }
            knob
        })
        .collect()
}

fn attach_model(
    block: &mut Value,
    catalog: Option<&Catalog>,
    model_number: Option<u32>,
    values: &[f32],
    irs: Option<&[(i64, String)]>,
) {
    let Some(n) = model_number else {
        return;
    };
    block["model"] = json!(n);
    let Some(catalog) = catalog else {
        return;
    };
    if let Some(model) = catalog.model_number(n) {
        block["model_id"] = json!(model.id);
        block["model_name"] = json!(model.name);
        if let Some(cat) = catalog
            .category_of(&model.id)
            .and_then(|id| catalog.category(id))
        {
            block["category"] = json!(cat.name);
        }
        let stereo = stereo_variant(catalog, n);
        if let Some(stereo) = stereo {
            block["stereo"] = json!(stereo);
        }
        let cost = model.dsp_load(stereo.unwrap_or(false));
        if cost > 0.0 {
            block["load"] = json!(cost);
        }
    }
    let mut knobs = knobs_json(catalog, n, values);
    if let Some(irs) = irs {
        overlay_ir_choices(&mut knobs, irs, values);
    }
    if !knobs.is_empty() {
        block["knobs"] = json!(knobs);
    }
}

/// Whether this wire number is the stereo firmware symbol of a dual-width model.
///
/// HX Edit folds mono and stereo into one catalog id. The device keeps two
/// symbols (`HD2_ReverbRoom` and `HD2_ReverbRoomStereo`). `None` when the model
/// has only one width (amps, most cabs).
pub(crate) fn stereo_variant(catalog: &Catalog, number: u32) -> Option<bool> {
    let symbol = catalog.symbol(number)?;
    let model_id = symbol.model.as_deref()?;
    let mut saw_stereo = false;
    let mut saw_mono = false;
    for s in catalog.symbols() {
        if s.model.as_deref() != Some(model_id) {
            continue;
        }
        if s.symbol.ends_with("Stereo") {
            saw_stereo = true;
        } else {
            saw_mono = true;
        }
    }
    if saw_stereo && saw_mono {
        Some(symbol.symbol.ends_with("Stereo"))
    } else {
        None
    }
}

const INPUT_MODELS: &[&str] = &[
    "HD2_AppDSPFlow1Input",
    "HD2_AppDSPFlow2Input",
    "HelixStomp_AppDSPFlowInput",
];
const OUTPUT_MODELS: &[&str] = &[
    "HD2_AppDSPFlowOutput",
    "HD2_AppDSPFlow2Output",
    "HelixStomp_AppDSPFlowOutputMain",
];

fn routing_param_id(kind: Kind) -> Option<&'static str> {
    match kind {
        Kind::Input => Some("@input"),
        Kind::Output => Some("@output"),
        _ => None,
    }
}

/// USB assign index plus HX Edit menu labels for an Input/Output slot.
pub fn routing_labels(
    catalog: Option<&Catalog>,
    kind: Kind,
    value: i64,
) -> Option<(String, Vec<Value>)> {
    let catalog = catalog?;
    let wanted = routing_param_id(kind)?;
    let ids = match kind {
        Kind::Input => INPUT_MODELS,
        Kind::Output => OUTPUT_MODELS,
        _ => return None,
    };
    let model = ids.iter().find_map(|id| catalog.model(id))?;
    let param = model.params.iter().find(|p| p.id == wanted)?;
    let choices = catalog.choices(param)?;
    let menu: Vec<Value> = choices
        .iter()
        .enumerate()
        .map(|(i, label)| json!({"value": i, "label": label}))
        .collect();
    let label = choices
        .get(value as usize)
        .cloned()
        .unwrap_or_else(|| value.to_string());
    Some((label, menu))
}

/// SPA-shaped dump: USB slot index as `block`, dual-cab leaf as `subslot` 1.
pub fn blocks_from_preset(
    preset: &Preset,
    catalog: Option<&Catalog>,
    irs: Option<&[(i64, String)]>,
) -> Vec<Value> {
    let layout = preset.layout();
    let split_in_use = layout.paths.iter().any(|p| !p.lanes.is_empty());
    let mut out = Vec::new();
    for (position, slot) in preset.slots.iter().enumerate() {
        if matches!(slot.kind, Kind::Empty) {
            continue;
        }
        if !split_in_use && matches!(slot.kind, Kind::Split | Kind::Join) {
            continue;
        }
        if slot.values.is_empty()
            && slot.paired_values.is_empty()
            && preset.routing(position).is_none()
        {
            continue;
        }
        let mut block = json!({
            "block": position,
            "subslot": 0,
            "kind": kind_num(slot.kind),
            "params": params_json(&slot.values),
            "enabled": slot.enabled,
        });
        attach_model(&mut block, catalog, slot.model, &slot.values, irs);
        if let Some(assign) = preset.routing(position) {
            block["assign"] = json!(assign);
            if let Some((label, menu)) = routing_labels(catalog, slot.kind, assign) {
                block["assign_label"] = json!(label);
                block["assign_menu"] = json!(menu);
            }
        }
        out.push(block);
        if !slot.paired_values.is_empty() {
            let mut cab = json!({
                "block": position,
                "subslot": 1,
                "kind": kind_num(slot.kind),
                "params": params_json(&slot.paired_values),
                "enabled": slot.enabled,
            });
            attach_model(&mut cab, catalog, slot.paired, &slot.paired_values, irs);
            out.push(cab);
        }
    }
    out
}

pub fn topology_from_preset(
    preset: &Preset,
    catalog: Option<&Catalog>,
    irs: Option<&[(i64, String)]>,
) -> Value {
    let layout: Layout = preset.layout();
    let paths: Vec<Value> = layout
        .paths
        .iter()
        .enumerate()
        .map(|(i, path)| {
            json!({
                "id": i + 1,
                "input": path.input,
                "output": path.output,
                "split": path.split,
                "join": path.join,
                "split_at": path.split.and_then(|p| preset.attach_of(p)),
                "join_at": path.join.and_then(|p| preset.attach_of(p)),
                "head": path.head,
                "tail": path.tail,
                "lanes": path.lanes.iter().map(|lane| json!({
                    "branch": lane.branch,
                    "blocks": lane.blocks,
                    "span": [lane.span.start, lane.span.end],
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "paths": paths,
        "blocks": blocks_from_preset(preset, catalog, irs),
        "snapshots": preset.snapshots(),
        "snapshot": current_snapshot(preset),
    })
}

/// Snapshot-section key 6 is the live current index (0-based).
///
/// Live 2026-08-26 on Helix Floor 3.80: opcode 88 `select_snapshot` N updates
/// this field to N. Key 8 did not follow the selection.
fn current_snapshot(preset: &Preset) -> Option<i64> {
    preset
        .tone
        .get(10)
        .and_then(|s| s.get(6))
        .and_then(|v| v.as_i64())
}

pub fn slot_param(preset: &Preset, block: usize, subslot: u8, param: usize) -> Option<Value> {
    let slot = preset.slots.get(block)?;
    let values = if subslot == 1 {
        &slot.paired_values
    } else {
        &slot.values
    };
    values.get(param).copied().map(num)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRESET: &[u8] =
        include_bytes!("../../../vendor/tonepush/crates/hx-proto/tests/preset.bin");

    #[test]
    fn fixture_preset_yields_blocks() {
        let preset = Preset::parse(PRESET).expect("stomp fixture");
        let blocks = blocks_from_preset(&preset, None, None);
        assert!(!blocks.is_empty(), "expected occupied slots");
        assert!(
            blocks.iter().any(|b| b["kind"] == 0),
            "input slot missing: {blocks:?}"
        );
        let topo = topology_from_preset(&preset, None, None);
        assert!(topo["paths"].as_array().is_some_and(|p| !p.is_empty()));
        assert!(topo["paths"][0].get("head").is_some());
        assert!(topo["paths"][0].get("lanes").is_some());
        assert_eq!(topo["snapshot"], 0);
    }

    #[test]
    fn catalog_attaches_names_when_resources_present() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources");
        if !dir.join("Helix.sym").is_file() {
            return;
        }
        let catalog = hx_catalog::Catalog::load_from(&dir).expect("local HX Edit catalog");
        let preset = Preset::parse(PRESET).expect("stomp fixture");
        let blocks = blocks_from_preset(&preset, Some(&catalog), None);
        let named = blocks
            .iter()
            .find(|b| b["knobs"].as_array().is_some_and(|k| !k.is_empty()));
        assert!(
            named.is_some(),
            "expected at least one named block: {blocks:?}"
        );
        let knobs = named.unwrap()["knobs"].as_array().unwrap();
        assert!(knobs[0]["name"].is_string());
        assert!(knobs[0]["min"].is_number());
        assert!(knobs[0]["max"].is_number());
        assert!(
            blocks
                .iter()
                .any(|b| b["load"].as_f64().unwrap_or(0.0) > 0.0),
            "expected DSP load on at least one block: {blocks:?}"
        );
    }

    fn load_lab_catalog() -> Option<hx_catalog::Catalog> {
        let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let dirs = [
            here.join("../../resources"),
            dirs_next_home().join(".local/share/tonepush/hx-resources"),
        ];
        for dir in dirs {
            if dir.join("Helix.sym").is_file() && dir.join("HelixControls.json").is_file() {
                return hx_catalog::Catalog::load_from(&dir).ok();
            }
        }
        hx_catalog::Catalog::load().ok()
    }

    fn dirs_next_home() -> std::path::PathBuf {
        std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default()
    }

    fn wire_number(catalog: &hx_catalog::Catalog, model_id: &str) -> Option<u32> {
        catalog
            .symbols()
            .iter()
            .find(|s| s.model.as_deref() == Some(model_id))
            .map(|s| s.number)
    }

    #[test]
    fn deluxe_comp_ratio_and_heir_apparent_menus_when_catalog_present() {
        let Some(catalog) = load_lab_catalog() else {
            return;
        };
        let deluxe = wire_number(&catalog, "HD2_CompressorDeluxeComp").expect("Deluxe Comp symbol");
        let knobs = knobs_json(&catalog, deluxe, &[]);
        let ratio_i = knobs
            .iter()
            .find(|k| k["id"] == "Ratio")
            .and_then(|k| k["index"].as_u64())
            .expect("Ratio index") as usize;
        let mut deluxe_vals = vec![0.0; knobs.len().max(ratio_i + 1)];
        deluxe_vals[ratio_i] = 3.0;
        let knobs = knobs_json(&catalog, deluxe, &deluxe_vals);
        let ratio = knobs
            .iter()
            .find(|k| k["id"] == "Ratio")
            .expect("Ratio knob");
        assert_eq!(ratio["kind"], "enum");
        assert_eq!(ratio["usb"], "int");
        assert_eq!(ratio["label"], "6:1");
        let choices = ratio["choices"].as_array().expect("Ratio choices");
        assert_eq!(
            choices
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>(),
            ["2:1", "3:1", "4:1", "6:1", "10:1", "20:1"]
        );

        let heir = wire_number(&catalog, "HD2_DistHeirApparent").expect("Heir Apparent symbol");
        let knobs = knobs_json(&catalog, heir, &[]);
        let clip_i = knobs
            .iter()
            .find(|k| k["id"] == "Clipping")
            .and_then(|k| k["index"].as_u64())
            .expect("Clipping index") as usize;
        let gain_i = knobs
            .iter()
            .find(|k| k["id"] == "GainMod")
            .and_then(|k| k["index"].as_u64())
            .expect("Gain Mod index") as usize;
        let mut heir_vals = vec![0.0; knobs.len().max(clip_i.max(gain_i) + 1)];
        heir_vals[clip_i] = 1.0;
        heir_vals[gain_i] = 0.0;
        let knobs = knobs_json(&catalog, heir, &heir_vals);
        let clipping = knobs
            .iter()
            .find(|k| k["id"] == "Clipping")
            .expect("Clipping knob");
        assert_eq!(clipping["label"], "Boost");
        assert_eq!(
            clipping["choices"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>(),
            ["Overdrive", "Boost", "Distortion"]
        );
        let gain_mod = knobs
            .iter()
            .find(|k| k["id"] == "GainMod")
            .expect("Gain Mod knob");
        assert_eq!(gain_mod["label"], "Normal");
        assert_eq!(
            gain_mod["choices"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>(),
            ["Normal", "Higher"]
        );
    }

    #[test]
    fn input_assign_2_is_guitar_when_catalog_present() {
        let Some(catalog) = load_lab_catalog() else {
            return;
        };
        let (label, menu) = routing_labels(Some(&catalog), Kind::Input, 2).expect("input menu");
        assert_eq!(label, "Guitar");
        assert!(
            menu.iter()
                .any(|row| row["value"] == 2 && row["label"] == "Guitar"),
            "expected USB 2 → Guitar in {menu:?}"
        );
    }

    #[test]
    fn stereo_variant_splits_folded_catalog_ids() {
        let Some(catalog) = load_lab_catalog() else {
            return;
        };
        let stereo = catalog
            .symbols()
            .iter()
            .find(|s| s.symbol.ends_with("Stereo") && s.model.is_some())
            .expect("a Stereo firmware symbol");
        let model_id = stereo.model.as_deref().unwrap();
        let mono = catalog
            .symbols()
            .iter()
            .find(|s| s.model.as_deref() == Some(model_id) && !s.symbol.ends_with("Stereo"))
            .expect("matching mono symbol");
        assert_eq!(stereo_variant(&catalog, stereo.number), Some(true));
        assert_eq!(stereo_variant(&catalog, mono.number), Some(false));
        let amp = catalog
            .model("HD2_AmpEssexA30")
            .and_then(|m| {
                catalog
                    .symbols()
                    .iter()
                    .find(|s| s.model.as_deref() == Some(m.id.as_str()))
            })
            .expect("Essex A30 wire number");
        assert_eq!(stereo_variant(&catalog, amp.number), None);
    }

    #[test]
    fn overlay_ir_choices_names_occupied_slots() {
        let mut knobs = vec![json!({
            "index": 0,
            "id": "Index",
            "name": "IR Select",
            "display": "ir_select",
            "choices": ["-", "-", "-", "-"],
            "label": "-",
        })];
        overlay_ir_choices(
            &mut knobs,
            &[
                (0, "Essex Cab".into()),
                (2, "   ".into()),
                (3, "Heir Apparent".into()),
            ],
            &[0.0],
        );
        let choices = knobs[0]["choices"].as_array().expect("choices");
        assert_eq!(choices[0], "1  Essex Cab");
        assert_eq!(choices[1], "2");
        assert_eq!(choices[2], "3");
        assert_eq!(choices[3], "4  Heir Apparent");
        assert_eq!(knobs[0]["label"], "1  Essex Cab");
    }

    #[test]
    fn overlay_skips_non_ir_menus() {
        let mut knobs = vec![json!({
            "index": 1,
            "id": "Ratio",
            "name": "Ratio",
            "display": "compressor_ratio",
            "choices": ["2:1", "3:1"],
            "label": "2:1",
        })];
        overlay_ir_choices(&mut knobs, &[(0, "Essex Cab".into())], &[0.0, 0.0]);
        assert_eq!(knobs[0]["choices"][0], "2:1");
        assert_eq!(knobs[0]["label"], "2:1");
    }

    #[test]
    fn ir_1024_select_is_placeholder_dashes_until_overlaid() {
        let Some(catalog) = load_lab_catalog() else {
            return;
        };
        let n = wire_number(&catalog, "HD2_ImpulseResponse1024").expect("IR 1024");
        let mut knobs = knobs_json(&catalog, n, &[2.0]);
        let dashes = knobs
            .iter()
            .find(|k| k["id"] == "Index")
            .expect("IR Select");
        assert_eq!(dashes["display"], "ir_select");
        let choices = dashes["choices"].as_array().expect("ir_select choices");
        assert_eq!(choices.len(), IR_SLOTS);
        assert!(choices.iter().all(|c| c == "-"));
        overlay_ir_choices(&mut knobs, &[(2, "Heir Apparent".into())], &[2.0]);
        let sel = knobs
            .iter()
            .find(|k| k["id"] == "Index")
            .expect("IR Select");
        assert_eq!(sel["choices"][2], "3  Heir Apparent");
        assert_eq!(sel["label"], "3  Heir Apparent");
    }
}
