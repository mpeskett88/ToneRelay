//! One-shot: rebuild a Floor preset from its `.hlx` and opcode-8 it onto 05D.
//!
//! Stops being useful once import uses this path. Run only with the USB daemon
//! down, against a throwaway dest that this program restores on the way out.
//!
//!   sudo systemctl stop hxbridge-usb.service
//!   cargo run -p hxbridge-usb --example probe_hlx_encode -- 6 18 19
//!   sudo systemctl start hxbridge-usb.service

use std::path::PathBuf;

use hx_catalog::{empty_the_chain, slots_from_hlx, to_hlx, Catalog};
use hx_proto::preset::Kind;
use hx_proto::Preset;

fn catalog() -> Catalog {
    match Catalog::load() {
        Ok(c) => c,
        Err(_) => {
            let local = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
            Catalog::load_from(&local).expect("HX Edit catalog")
        }
    }
}

fn user_blocks(preset: &Preset) -> usize {
    preset
        .slots
        .iter()
        .filter(|s| s.kind == Kind::Block && s.model.is_some())
        .count()
}

fn fingerprint(preset: &Preset) -> Vec<(Kind, Option<u32>)> {
    preset.slots.iter().map(|s| (s.kind, s.model)).collect()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let setlist: i64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(6);
    let source: i64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(18);
    let dest: i64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(19);

    let catalog = catalog();
    let found = hx_usb::list().expect("list");
    let device = found
        .iter()
        .find(|d| d.profile.product_id == 0x4248)
        .or_else(|| found.first())
        .expect("no Helix");
    let mut session = device.open().expect("open");

    let original = session
        .read_preset_at(setlist, source)
        .expect("read source")
        .expect("source slot is empty");
    let names = session.presets(setlist).unwrap_or_default();
    let source_name = names
        .get(source as usize)
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "probe".into());
    let dest_name = names
        .get(dest as usize)
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "restored".into());
    let dest_backup = session.read_preset_at(setlist, dest).expect("read dest");
    eprintln!(
        "source {setlist}/{source} {source_name:?} {} bytes {} blocks; dest {dest} {dest_name:?} {}",
        original.encode().len(),
        user_blocks(&original),
        match &dest_backup {
            Some(p) => format!("{} bytes {} blocks", p.encode().len(), user_blocks(p)),
            None => "empty".into(),
        }
    );

    let hlx = to_hlx(&original, &catalog, &source_name).document;
    let mut rebuilt = Preset::parse(&original.encode()).expect("source re-parses");
    empty_the_chain(&mut rebuilt);
    let built = slots_from_hlx(&mut rebuilt, &hlx, &catalog);
    let orig_bytes = original.encode();
    let new_bytes = rebuilt.encode();
    eprintln!(
        "rebuild: blocks {} skipped {:?} byte_eq {} ({} vs {})",
        built.blocks,
        built.skipped,
        orig_bytes == new_bytes,
        orig_bytes.len(),
        new_bytes.len()
    );

    let write = session.write_preset_at(setlist, dest, &source_name, &rebuilt);
    let after = session.read_preset_at(setlist, dest);
    match (&write, &after) {
        (Ok(()), Ok(Some(got))) => {
            let same = fingerprint(got) == fingerprint(&rebuilt);
            eprintln!(
                "after write: {} blocks fingerprint_match={same}",
                user_blocks(got)
            );
            if user_blocks(&rebuilt) > 0 && user_blocks(got) == 0 {
                eprintln!("FAIL: device stored the document and loaded it empty");
            } else if same {
                eprintln!("PASS: dest kept the rebuilt chain");
            } else {
                eprintln!(
                    "PARTIAL: dest has {} blocks, rebuilt had {}",
                    user_blocks(got),
                    user_blocks(&rebuilt)
                );
            }
        }
        (Err(e), _) => eprintln!("write failed: {e}"),
        (Ok(()), Ok(None)) => eprintln!("FAIL: dest empty after write"),
        (Ok(()), Err(e)) => eprintln!("read-back failed: {e}"),
    }

    match dest_backup {
        Some(backup) => {
            if let Err(e) = session.write_preset_at(setlist, dest, &dest_name, &backup) {
                eprintln!("restore dest failed: {e}");
            } else {
                eprintln!("dest restored");
            }
        }
        None => {
            if let Err(e) = session.clear_preset_at(setlist, dest) {
                eprintln!("clear dest failed: {e}");
            } else {
                eprintln!("dest cleared (was empty)");
            }
        }
    }
}
