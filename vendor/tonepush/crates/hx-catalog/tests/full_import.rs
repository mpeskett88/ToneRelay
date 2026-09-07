//! Import of snapshots, controller assignments and Command Centre from a `.hlx`.

use std::path::PathBuf;

use hx_catalog::{empty_the_chain, slots_from_hlx, to_hlx, Catalog};
use hx_proto::msgpack::Value;
use hx_proto::Preset;

fn catalog() -> Option<Catalog> {
    Catalog::load().ok().or_else(|| {
        let local = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../resources");
        Catalog::load_from(&local).ok()
    })
}

fn floor_bethel() -> Option<Preset> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/floor-bethel.hxpreset");
    Preset::parse(&std::fs::read(path).ok()?)
}

fn essex() -> Option<serde_json::Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../captures/Essex A30.hlx");
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn cc_labels(preset: &Preset) -> Vec<String> {
    let Some(Value::Array(cells)) = preset.tone.get(3).and_then(|cc| cc.get(8)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for cell in cells {
        let Value::Array(items) = cell else {
            continue;
        };
        for item in items {
            if let Some(label) = item.get(14).and_then(Value::as_str) {
                out.push(label.to_owned());
            }
        }
    }
    out
}

fn assignment_triples(preset: &Preset) -> Vec<(i64, i64, i64)> {
    let Some(Value::Array(by_source)) = preset.tone.get(4) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (ordinal, entries) in by_source.iter().enumerate() {
        let Value::Array(entries) = entries else {
            continue;
        };
        for entry in entries {
            let Some(what) = entry.get(1) else {
                continue;
            };
            let Some(block) = what.get(5).and_then(Value::as_i64) else {
                continue;
            };
            let param = what
                .get(6)
                .and_then(|t| t.get(29))
                .and_then(Value::as_i64)
                .unwrap_or(-1);
            out.push((ordinal as i64, block, param));
        }
    }
    out.sort();
    out
}

/// A Floor native document survives `.hlx` and back with its assignments,
/// snapshot names and Command Centre labels intact.
#[test]
fn floor_round_trip_keeps_assignments_and_command_centre() {
    let Some(catalog) = catalog() else {
        eprintln!("skipping: HX Edit catalog is not installed");
        return;
    };
    let Some(original) = floor_bethel() else {
        panic!("floor-bethel.hxpreset is missing");
    };
    let hlx = to_hlx(&original, &catalog, "Bethel").document;
    assert!(
        hlx.pointer("/data/tone/controller").is_some(),
        "export must emit controller assignments"
    );
    assert!(
        hlx.pointer("/data/tone/footswitch").is_some(),
        "export must emit Command Centre bypasses"
    );
    assert_eq!(
        hlx.pointer("/data/tone/snapshot3/@name")
            .and_then(|v| v.as_str()),
        Some("PAD")
    );

    let mut rebuilt = Preset::parse(&original.encode()).expect("reparse");
    empty_the_chain(&mut rebuilt);
    let built = slots_from_hlx(&mut rebuilt, &hlx, &catalog);
    assert!(
        built.blocks > 0,
        "chain should land, skipped {:?}",
        built.skipped
    );

    assert_eq!(rebuilt.snapshots(), original.snapshots());
    assert_eq!(
        assignment_triples(&rebuilt),
        assignment_triples(&original),
        "controller assignments"
    );
    assert_eq!(
        cc_labels(&rebuilt),
        cc_labels(&original),
        "Command Centre labels"
    );
}

/// An HX Edit `.hlx` writes its controller and footswitch sections onto a Floor
/// template rather than leaving the template's own assignments behind.
#[test]
fn essex_hlx_replaces_template_assignments() {
    let Some(catalog) = catalog() else {
        eprintln!("skipping: HX Edit catalog is not installed");
        return;
    };
    let Some(template) = floor_bethel() else {
        panic!("floor-bethel.hxpreset is missing");
    };
    let Some(hlx) = essex() else {
        eprintln!("skipping: captures/Essex A30.hlx is not present");
        return;
    };

    let mut rebuilt = Preset::parse(&template.encode()).expect("reparse");
    empty_the_chain(&mut rebuilt);
    let built = slots_from_hlx(&mut rebuilt, &hlx, &catalog);
    assert!(built.blocks > 0, "Essex chain, skipped {:?}", built.skipped);

    let assigns = assignment_triples(&rebuilt);
    assert_eq!(
        assigns.len(),
        3,
        "Essex has three controller assignments: {assigns:?}"
    );
    assert!(
        assigns.iter().any(|(src, _, _)| *src == 1),
        "EXP 1: {assigns:?}"
    );
    assert!(
        assigns.iter().any(|(src, _, _)| *src == 2),
        "EXP 2: {assigns:?}"
    );
    assert!(
        assigns.iter().any(|(src, _, _)| *src == 19),
        "controller 19: {assigns:?}"
    );

    let labels = cc_labels(&rebuilt);
    assert!(
        labels.iter().any(|l| l.contains("Volume")),
        "Volume Pedal on Command Centre: {labels:?}"
    );
    assert!(
        labels
            .iter()
            .any(|l| l.contains("Dynamic") || l.contains("Room")),
        "reverb on Command Centre: {labels:?}"
    );
    assert!(
        !labels.iter().any(|l| l.contains("1st stage")),
        "Bethel Command Centre must not survive Essex import: {labels:?}"
    );
    assert_eq!(rebuilt.snapshots()[0], "SNAPSHOT 1");
}
