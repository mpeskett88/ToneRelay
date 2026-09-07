//! Print the tone-map keys a native `l6-helix` document actually carries.
//!
//!   cargo run -p hx-catalog --example dump_tone -- /tmp/op8-txn1006.bin

use std::env;
use std::fs;

use hx_proto::msgpack::{Key, Value};
use hx_proto::Preset;

fn map_keys(v: &Value) -> String {
    match v {
        Value::Map(m) => m
            .iter()
            .map(|(k, v)| format!("{k:?}:{}", kind(v)))
            .collect::<Vec<_>>()
            .join(", "),
        other => kind(other),
    }
}

fn kind(v: &Value) -> String {
    match v {
        Value::Nil => "nil".into(),
        Value::Bool(b) => format!("bool:{b}"),
        Value::Int(i) => format!("int:{i}"),
        Value::UInt(u) => format!("uint:{u}"),
        Value::Wide(u, w) => format!("wide{w}:{u}"),
        Value::WideInt(i, w) => format!("wideint{w}:{i}"),
        Value::F32(f) => format!("f32:{f}"),
        Value::F64(f) => format!("f64:{f}"),
        Value::Str(s) => format!("str:{s:?}"),
        Value::Bin(b, _) => format!("bin{}", b.len()),
        Value::Array(a) => format!("arr{}", a.len()),
        Value::Map(m) => format!("map{}", m.len()),
    }
}

fn compact(v: &Value, depth: usize) -> String {
    if depth == 0 {
        return kind(v);
    }
    match v {
        Value::Array(a) => {
            let inner: Vec<_> = a.iter().take(6).map(|x| compact(x, depth - 1)).collect();
            let extra = if a.len() > 6 {
                format!(", …+{}", a.len() - 6)
            } else {
                String::new()
            };
            format!("[{}{extra}]", inner.join(", "))
        }
        Value::Map(m) => {
            let inner: Vec<_> = m
                .iter()
                .map(|(k, x)| format!("{k:?}: {}", compact(x, depth - 1)))
                .collect();
            format!("{{{}}}", inner.join(", "))
        }
        other => kind(other),
    }
}

fn main() {
    let path = env::args().nth(1).expect("path to l6-helix blob");
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let preset = Preset::parse(&bytes).expect("parse");
    println!(
        "slots {} assignments {}",
        preset.slots.len(),
        preset.assignments().len()
    );
    println!("snapshots {:?}", preset.snapshots());
    println!("tone keys: {}", map_keys(&preset.tone));

    if let Some(assigns) = preset.tone.get(4) {
        println!("\n=== key 4 assignments ===");
        println!("{}", compact(assigns, 1));
        if let Value::Array(by_source) = assigns {
            for (i, entry) in by_source.iter().enumerate() {
                let empty =
                    matches!(entry, Value::Nil) || matches!(entry, Value::Array(a) if a.is_empty());
                if empty {
                    continue;
                }
                println!("  ordinal {i}: {}", compact(entry, 3));
            }
        }
    }

    if let Some(settings) = preset.tone.get(5) {
        println!("\n=== key 5 settings ===");
        println!("{}", compact(settings, 2));
    }

    if let Some(snap) = preset.tone.get(10) {
        println!("\n=== key 10 snapshot section ===");
        println!("keys: {}", map_keys(snap));
        if let Some(Value::Array(entries)) = snap.get(10) {
            if let Some(first) = entries.first() {
                println!("snapshot0 keys: {}", map_keys(first));
                println!("snapshot0: {}", compact(first, 2));
            }
            if let Some(Value::Array(slots)) = first_slots(first_of(entries)) {
                println!("slot0: {}", compact(&slots[0], 2));
                println!(
                    "slot1: {}",
                    compact(&slots.get(1).unwrap_or(&Value::Nil), 2)
                );
                println!("n slots in snap0 {}", slots.len());
            }
        }
        if let Value::Map(m) = snap {
            for (k, v) in m {
                if matches!(k, Key::Int(10)) {
                    continue;
                }
                println!("  extra {k:?}: {}", compact(v, 2));
            }
        }
    }

    println!("\n=== parsed assignments ===");
    for a in preset.assignments() {
        println!("{a:?}");
    }

    for key in [2, 3, 6] {
        if let Some(v) = preset.tone.get(key) {
            println!("\n=== tone key {key} ===");
            println!("{}", compact(v, 4));
        }
    }

    if let Some(Value::Map(m)) = preset.tone.get(3) {
        if let Some((_, Value::Array(cells))) = m.iter().find(|(k, _)| *k == Key::Int(8)) {
            println!("\n=== Command Centre cells ({}) ===", cells.len());
            for (i, cell) in cells.iter().enumerate() {
                if matches!(cell, Value::Nil) {
                    continue;
                }
                println!("  cell {i}: {}", compact(cell, 5));
            }
        }
    }

    if let Some(Value::Array(entries)) = preset.tone.get(10).and_then(|s| s.get(10)) {
        if let Some(first) = entries.first() {
            for k in [1, 2] {
                if let Some(Value::Array(rows)) = first.get(k) {
                    println!("\n=== snapshot0 key {k} ({} rows) ===", rows.len());
                    for (i, row) in rows.iter().enumerate().take(8) {
                        println!("  [{i}] {}", compact(row, 2));
                    }
                    if rows.len() > 8 {
                        println!("  …");
                        println!(
                            "  [{}] {}",
                            rows.len() - 1,
                            compact(rows.last().unwrap(), 2)
                        );
                    }
                    let nonempty = rows
                        .iter()
                        .enumerate()
                        .filter(|(_, r)| match r {
                            Value::Array(a) => a.iter().any(|x| !matches!(x, Value::Nil)),
                            Value::Nil => false,
                            _ => true,
                        })
                        .count();
                    println!("  nonempty {nonempty}");
                }
            }
        }
    }

    if let Some(Value::Array(by_source)) = preset.tone.get(4) {
        println!("\n=== assignment bodies ===");
        for (i, entry) in by_source.iter().enumerate() {
            let Value::Array(items) = entry else {
                continue;
            };
            if items.is_empty() {
                continue;
            }
            for (j, item) in items.iter().enumerate() {
                println!("  [{i}][{j}] {}", compact(item, 4));
            }
        }
    }
}

fn first_of(entries: &[Value]) -> Option<&Value> {
    entries.first()
}

fn first_slots(entry: Option<&Value>) -> Option<&Value> {
    entry?.get(3)
}
