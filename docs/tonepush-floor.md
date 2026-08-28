# TonePush on Helix Floor

hxblue uses [TonePush](https://github.com/crmne/tonepush) (`hx-proto` + `hx-usb`) as the USB engine. The browser GUI still uses Bluetooth and Wi-Fi.

The USB daemon is `hxbridge-usb`. GATT and HTTPS send JSON to `/tmp/hxbridge-usb.sock`. Do not run `openhx-cli` at the same time as the daemon.

USB uses vendored TonePush crates under `vendor/tonepush/` (`hx-proto`, `hx-usb`, `hx-catalog`).

## Lab eval (2026-08-18)

Toolchain: rustc 1.97.1. TonePush `hx-proto` and `hx-usb` unit tests passed. Hardware tests stay ignored until a live notify drain is proven.

Helix Floor PID `0e41:4248` is already a TonePush `DeviceProfile` (128 presets, 10 switches). Stomp is `0e41:4246` (126 presets, 5 switches). Firmware 3.80 matches. Serial on this unit: `2707520`. Device id `0x00210001`.

Read-only CLI on the live Essex A30 preset (`01B`):

- `tonepush list` / `info` / `presets` / `topology` / `watch` (3 s) completed. The Helix stayed on the bus. No 9V pull.
- Topology: `0 Input -> 1 Wah -> 2 Volume -> 3 Drive -> 4 Essex -> 5 Trem -> 6 Cab -> 7 Reverb -> 9 Output`. That matches the hxblue USB map. Parked split/merge sit in the document as slots 10 and 19 with empty lanes. The daemon omits them from `get_state` so the GUI does not draw unused junctions.
- Live write: Path 1 Input `noiseGate` (`set_bool` block 0 param 0) Off then On. Both replies were `ok`. The Helix stayed on the bus.
- `tonepush chain` prints 1-based labels that skip the input (`2.` is slot 1). The JSON daemon uses slot indexes from `topology`, not those labels.

TonePush says Command Center opcodes are inert on a Stomp. Do not send those writes from this bridge.

TonePush `Session::set_param` hard-codes path 0. The daemon passes `subslot` as key 26 so Cab 2 still works.

## Catalog (HX Edit files)

Names and pictures come from HX Edit. They are Line 6's. Do not commit them.

A local copy of the JSON catalog (`.models`, `Helix.sym`, `HX_ModelCatalog.json`, `HelixControls.json`) may sit in `/home/admin/hxblue/resources/`. That directory is gitignored. Install it where TonePush looks:

```
mkdir -p ~/.local/share/tonepush/hx-resources
cp /home/admin/hxblue/resources/* ~/.local/share/tonepush/hx-resources/
```

Or set `HX_RESOURCES_DEST` to that folder. Artwork dirs `icons_models` and `icons_category` are optional; without them you get names and ranges but no HX Edit pictures.

To extract from an installer instead: `./scripts/extract-hx-catalog.sh` or `./scripts/extract-hx-catalog.sh HX_Edit_3.82.dmg`.

The daemon loads this catalog at start (`Catalog::load`, then `hxblue/resources`). `get_state` then attaches `model_id`, `model_name`, `category`, and `knobs` (name, min, max, kind, HX Edit label). The GUI still works without that cache. It then shows model numbers and the live Essex map.

## Run

1. Stop GATT so it does not claim USB: `sudo systemctl stop hxbridge-gatt.service`.
2. Build: `cargo build -p hxbridge-usb`.
3. Start the daemon: `./target/debug/hxbridge-usb`.
4. Start GATT and HTTPS again after the daemon is up.

Optional units: `scripts/hxbridge-usb.service` is a template with placeholders. For a boot-time install, run `sudo ./scripts/install.sh`.
