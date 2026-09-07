//! Offline: how a `.hlx` rebuild differs from the device document at the
//! MessagePack tag layer. Run with `--nocapture` to print the classification.

use std::fs;
use std::path::PathBuf;

use hx_catalog::{slots_from_hlx, Catalog};
use hx_proto::msgpack::{Key, Value};
use hx_proto::Preset;

fn fixtures() -> Vec<(String, Vec<u8>)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../hx-proto/tests/fixtures");
    let mut out: Vec<(String, Vec<u8>)> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("hxpreset"))
        .map(|p| {
            let name = p.file_stem().unwrap().to_string_lossy().into_owned();
            (name, fs::read(&p).unwrap())
        })
        .collect();
    out.sort();
    out
}

fn empty_slot() -> Value {
    Value::Map(vec![
        (Key::Int(19), Value::Int(8)),
        (Key::Int(20), Value::Nil),
    ])
}

fn tag(v: &Value) -> String {
    match v {
        Value::Nil => "nil".into(),
        Value::Bool(_) => "bool".into(),
        Value::Int(_) => "int".into(),
        Value::UInt(_) => "uint".into(),
        Value::Wide(_, w) => format!("wide{w}"),
        Value::WideInt(_, w) => format!("wideint{w}"),
        Value::F32(_) => "f32".into(),
        Value::F64(_) => "f64".into(),
        Value::Str(_) => "str".into(),
        Value::Bin(_, w) => format!("bin{w}"),
        Value::Array(a) => format!("arr{}", a.len()),
        Value::Map(m) => format!("map{}", m.len()),
    }
}

fn num_of(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(*b as u8 as f64),
        Value::Int(i) => Some(*i as f64),
        Value::UInt(u) => Some(*u as f64),
        Value::Wide(u, _) => Some(*u as f64),
        Value::WideInt(i, _) => Some(*i as f64),
        Value::F32(f) => Some(*f as f64),
        Value::F64(f) => Some(*f),
        _ => None,
    }
}

#[derive(Default)]
struct Stats {
    equal: usize,
    type_mismatch: usize,
    missing: usize,
    extra: usize,
    order: usize,
    len: usize,
    samples: Vec<String>,
}

impl Stats {
    fn note(&mut self, s: String) {
        if self.samples.len() < 40 {
            self.samples.push(s);
        }
    }
}

fn walk(a: &Value, b: &Value, path: &str, st: &mut Stats) {
    if std::mem::discriminant(a) == std::mem::discriminant(b) {
        match (a, b) {
            (Value::Array(x), Value::Array(y)) => {
                if x.len() != y.len() {
                    st.len += 1;
                    st.note(format!("{path}: arr {} vs {}", x.len(), y.len()));
                }
                for (i, (l, r)) in x.iter().zip(y.iter()).enumerate() {
                    walk(l, r, &format!("{path}[{i}]"), st);
                }
            }
            (Value::Map(x), Value::Map(y)) => {
                let ak: Vec<_> = x.iter().map(|(k, _)| format!("{k:?}")).collect();
                let bk: Vec<_> = y.iter().map(|(k, _)| format!("{k:?}")).collect();
                if ak != bk && {
                    let mut asort = ak.clone();
                    let mut bsort = bk.clone();
                    asort.sort();
                    bsort.sort();
                    asort == bsort
                } {
                    st.order += 1;
                    st.note(format!("{path}: key order {ak:?} vs {bk:?}"));
                }
                for (k, va) in x {
                    let key = format!("{k:?}");
                    match y.iter().find(|(kb, _)| kb == k) {
                        Some((_, vb)) => walk(va, vb, &format!("{path}.{key}"), st),
                        None => {
                            st.missing += 1;
                            st.note(format!("{path}.{key}: missing in rebuild ({})", tag(va)));
                        }
                    }
                }
                for (k, vb) in y {
                    if !x.iter().any(|(ka, _)| ka == k) {
                        st.extra += 1;
                        st.note(format!("{path}.{:?}: extra in rebuild ({})", k, tag(vb)));
                    }
                }
            }
            _ if a == b => st.equal += 1,
            _ => {
                st.type_mismatch += 1;
                st.note(format!("{path}: {} vs {}", tag(a), tag(b)));
            }
        }
        return;
    }
    // Different discriminants: still a type mismatch, even if numbers agree.
    st.type_mismatch += 1;
    let nums = match (num_of(a), num_of(b)) {
        (Some(x), Some(y)) if (x - y).abs() < 1e-5 => format!(" same_num={x}"),
        (Some(x), Some(y)) => format!(" {x} vs {y}"),
        _ => String::new(),
    };
    st.note(format!("{path}: {} vs {}{nums}", tag(a), tag(b)));
}

fn value_array<'a>(slot: &'a Value) -> Option<&'a [Value]> {
    let body = slot.get(20)?;
    let values = body.get(11)?;
    match values.get(4) {
        Some(Value::Array(a)) => Some(a),
        _ => None,
    }
}

fn slot_model(slot: &Value) -> Option<u32> {
    slot.get(20)?.get(24)?.get(25)?.as_i64().map(|n| n as u32)
}

fn slots_of(preset: &Preset) -> Option<&[Value]> {
    match preset.tone.get(0)?.get(22) {
        Some(Value::Array(a)) => Some(a),
        _ => None,
    }
}

#[test]
fn classify_rebuild_tag_mismatches() {
    let Ok(catalog) = Catalog::load() else {
        eprintln!("skipping: HX Edit catalog is not installed");
        return;
    };

    let mut st = Stats::default();
    let mut value_tags: Vec<(String, String, String)> = Vec::new();
    let mut sizes: Vec<(String, usize, usize, bool)> = Vec::new();

    for (name, bytes) in fixtures() {
        let original = Preset::parse(&bytes).expect("parses");
        let hlx = hx_catalog::to_hlx(&original, &catalog, &name).document;
        let mut rebuilt = Preset::parse(&bytes).expect("parses again");
        for i in 0..rebuilt.slots.len() {
            let _ = rebuilt.paste_slot(i, &empty_slot());
        }
        let built = slots_from_hlx(&mut rebuilt, &hlx, &catalog);
        eprintln!(
            "{name}: blocks {} skipped {:?}",
            built.blocks, built.skipped
        );

        let orig_bytes = original.encode();
        let new_bytes = rebuilt.encode();
        sizes.push((
            name.clone(),
            orig_bytes.len(),
            new_bytes.len(),
            orig_bytes == new_bytes,
        ));
        if orig_bytes != new_bytes {
            let at = orig_bytes
                .iter()
                .zip(new_bytes.iter())
                .position(|(a, b)| a != b)
                .unwrap_or(orig_bytes.len().min(new_bytes.len()));
            eprintln!(
                "{name}: DIVERGES at byte {at} orig {} rebuilt {}",
                orig_bytes.len(),
                new_bytes.len()
            );
        }

        walk(&original.tone, &rebuilt.tone, &name, &mut st);

        let Some(os) = slots_of(&original) else {
            continue;
        };
        let Some(rs) = slots_of(&rebuilt) else {
            continue;
        };
        for (i, (o, r)) in os.iter().zip(rs.iter()).enumerate() {
            let Some(oa) = value_array(o) else { continue };
            let Some(ra) = value_array(r) else { continue };
            let model = slot_model(o).or_else(|| slot_model(r));
            for (vi, (ov, rv)) in oa.iter().zip(ra.iter()).enumerate() {
                if tag(ov) == tag(rv) {
                    continue;
                }
                let kind = model
                    .and_then(|m| catalog.param(m, vi))
                    .map(|p| format!("{:?} {}", p.kind, p.id))
                    .unwrap_or_else(|| "?".into());
                value_tags.push((
                    format!("{name} slot{i} v{vi}"),
                    format!("{}→{} ({kind})", tag(ov), tag(rv)),
                    format!("{:?} vs {:?}", ov, rv),
                ));
            }
        }
    }

    eprintln!("\n=== document sizes ===");
    for (name, a, b, eq) in &sizes {
        eprintln!("  {name}: orig {a} rebuilt {b} equal={eq}");
    }
    eprintln!(
        "\n=== walk: equal {} type_mismatch {} missing {} extra {} order {} len {} ===",
        st.equal, st.type_mismatch, st.missing, st.extra, st.order, st.len
    );
    eprintln!("samples:");
    for s in &st.samples {
        eprintln!("  {s}");
    }
    eprintln!("\n=== value-array tag mismatches vs catalog Kind ===");
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for (_, what, _) in &value_tags {
        *counts.entry(what.clone()).or_default() += 1;
    }
    for (k, n) in &counts {
        eprintln!("  {n:4}  {k}");
    }
    for (where_, what, detail) in value_tags.iter().take(25) {
        eprintln!("  {where_}: {what}  {detail}");
    }
    let failed: Vec<_> = sizes
        .iter()
        .filter(|(_, _, _, eq)| !*eq)
        .map(|(n, a, b, _)| format!("{n} {a}->{b}"))
        .collect();
    assert!(
        failed.is_empty(),
        "rebuilt documents are not byte-identical to the device originals: {failed:?}"
    );
}
