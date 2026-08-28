# ToneRelay web GUI

The Pi serves a React GUI. The GUI talks to the Helix with one of two transports.

- **Wi-Fi** is the usual path. The browser opens the GUI over HTTP and talks to the Pi with a WebSocket. This path works on iPhone and Safari.
- **Bluetooth** is optional on Chrome or Edge, and only when the GUI is served over HTTPS. Apple does not expose Web Bluetooth.

This file uses ASD-STE100 Simplified Technical English (pragmatic mode). Full dictionary compliance needs the official list at asd-ste100.org.

## Safety

CAUTION: Do not use this lab server on an untrusted network. The GUI has no login. GATT writes are not encrypted. The default listen path is HTTP.

CAUTION: Two programs cannot claim the Helix at the same time. GATT and HTTP both take a USB lock file at `/tmp/hxbridge-usb.lock`. Wait for one dump to end before the next dump starts.

## Build the GUI

Node 20 is required on the build machine. The runtime Pi process does not need Node.

1. Run `cd ~/hxblue/web`.
2. Run `npm install`.
3. Run `npm test`.
4. Run `npm run build`.

The build writes files to `hxbridge/static/`.

## Run the servers

GATT and HTTP run as systemd services. You do not need a terminal session.

1. If `hxbridge-usb.service` is not active, run `sudo systemctl start hxbridge-usb.service`.
2. If `hxbridge-http.service` is not active, run `sudo systemctl start hxbridge-http.service`.
3. Open `http://<pi-hostname>.local/` in the browser (this Pi is `http://hxblue.local/`).

The USB daemon keeps its socket when the Helix is powered off. It opens a new session when the Floor enumerates again. You do not need to restart the unit after a power cycle that leaves the USB cable in place. JSON ops while it is waiting reply `helix not connected`.

Avahi advertises the HTTP service. If `.local` does not resolve, use `http://<pi-ip>/`.

For a first-time Pi, run `sudo ./scripts/install.sh` from the clone. That writes systemd units and Avahi from the templates in `scripts/`. Do not copy those templates to `/etc` until the placeholders are replaced.

The HTTP unit binds port 80 (or the port the installer chose) as the installing user. Port 80 uses `CAP_NET_BIND_SERVICE`.

To follow HTTP logs, run `journalctl -u hxbridge-http.service -f`.

If you need to run the Python process in a terminal, stop the unit first so port 80 is free: `sudo systemctl stop hxbridge-http.service`. Then run `python3 ~/hxblue/hxbridge/http_server.py --host 0.0.0.0`.

If you need HTTPS (Web Bluetooth on a LAN host), run `python3 ~/hxblue/hxbridge/http_server.py --https --host 0.0.0.0`. The first HTTPS start creates `hxbridge/certs/cert.pem` and `hxbridge/certs/key.pem`. Do not put the private key in git. Web Bluetooth does not work on `http://` with a LAN IP or a `.local` name.

## Connect screen

On the first visit, tap **Wi-Fi**. After a successful connect the GUI stores `tonerelay.transport` in `localStorage` and reconnects on refresh. Wi-Fi reconnects immediately. Bluetooth is a secondary control on Chrome; it reconnects only when `navigator.bluetooth.getDevices` still has ToneRelay.

On iPhone, use Share → Add to Home Screen. The icon is `apple-touch-icon.png`. The page title is ToneRelay.

The preset list is a drawer behind the header menu button on every viewport, including a laptop browser. It starts closed. The menu button opens and hides it. The chain grid stretches to the editor width. Effect tiles grow between about 6.25 rem and 9.25 rem; below that floor the board scrolls sideways. On a phone the chain still scrolls.

## Editor

The editor shows each DSP as Input, eight Path A cells, and Output. Input and Output are circular wire points like split and merge: icon only, no name on the tile. Path B is a second row of eight cells, aligned under Path A, when the split is live. Split and merge are larger points on the Path A wire (the slot they attach before), each with the split or merge icon. An SVG spine runs through Path A, including unused cells. A rounded loop runs from the split point to Path B, across those eight cells, and back to the merge point. The loop sits in the middle of the A/B gap, and its verticals sit in the wire gutters so they do not hug the tiles. Unused Path 2 stays hidden. Dual cab is one cell. A bypassed block is dimmer than an enabled block. Each effect tile has a small On/Off control in the upper-right corner (`set_bypass`, type 41). Input, Output, split, and merge do not have that control. Tap the inspector title on an effect to open a model sheet: categories, then Mono/Stereo/Legacy when those shelves exist, then models (`list_models` then `set_model`). Models that need more DSP than the path has left are dim and not selectable. A replace credits the current block's catalog load. The tile shows **M** or **S** in the top left when the firmware has both widths; picking a shelf sends `"stereo":true` or `"stereo":false` so the matching wire number is used. Tap an empty cell to open the same sheet and put a model in that slot. Amp+Cab uses `"pair":true`. Favourites are not in this sheet. A trash control sits to the right of the inspector model name and clears that slot (`clear_block`, opcode 28). Input, Output, split, merge, and empty cells do not have it. The device may refuse a model that does not fit (`error -306`). Error banners clear after five seconds. Long-press (~400 ms) an effect to pick it up; a floating copy follows the pointer (or finger). The chain does not pan during the drag, except a short auto-scroll when the pointer is near the edge of the chain frame. Drop on an empty cell on the same DSP (`move_block`, opcode 43). Split and merge do not move.

A snapshot strip sits under the chain. The current snapshot is marked from `get_state`. The GUI polls `events` about once a second and refreshes when the Floor changes.

Input and Output Assign menus use catalog labels when the daemon has HX Edit resources. Discrete parameters (Ratio, Clipping, Gain Mod, Voltage) use labels from `HelixControls.json`. IR Select uses names from the device IR list (opcode 13) in place of the catalog dashes; empty slots show the 1-based slot number. Six or fewer choices show as a segmented row on the same grid as sliders; longer lists stay a pill menu. Without a catalog the control stays numeric.

## Commands

The command set is the GATT set plus `get_state`, `preset_info`, `events`, `select_snapshot`, `move_block`, `set_model`, `clear_block`, `list_models`, `list_irs`, and `save_preset`.

`get_state` reads the loaded preset. The reply has `blocks`, `paths`, `snapshots`, `snapshot` (0-based current snapshot from the preset document), and the active `{setlist, index, name}`. `paths` is the TonePush layout and includes `split_at` / `join_at` (the Path A slot each junction sits just before). The GUI draws eight Path A cells and eight Path B cells; split and merge are wire points at those attach slots. When the catalog is loaded, I/O blocks also have `assign_label` and `assign_menu`, and each knob may include `choices` (the HX Edit menu for that parameter). IR Select `choices` are device IR names, not the catalog dashes. Occupied blocks also have `load` (catalog DSP percent for that width).

## Tests

1. Do a test of the command parser: `python3 ~/hxblue/hxbridge/test_protocol.py`.
2. Do a test of GATT chunks, chain grid, and catalog helpers: `cd ~/hxblue/web && npm test`.
3. Do a test of the USB helpers: `cargo test -p hxbridge-usb`.
4. Build the GUI: `cd ~/hxblue/web && npm run build`.
5. Run Playwright against the mock USB daemon (no Helix). Playwright must be installed (`python3 -m venv .venv && .venv/bin/pip install playwright && .venv/bin/playwright install chromium`):

```
export HXBRIDGE_USB_SOCK=/tmp/hxbridge-gui-test.sock
python3 ~/hxblue/.agents/skills/webapp-testing/scripts/with_server.py \
  --server "exec python3 ~/hxblue/hxbridge/mock_usb.py --sock $HXBRIDGE_USB_SOCK --ready-port 18081" --port 18081 \
  --server "export HXBRIDGE_USB_SOCK=$HXBRIDGE_USB_SOCK; exec python3 ~/hxblue/hxbridge/http_server.py --http --host 127.0.0.1 --port 8080" --port 8080 \
  -- .venv/bin/python ~/hxblue/hxbridge/test_gui.py
```

Live Helix checks stay read-only (`preset_info`, `get_state`) unless `HXBRIDGE_LIVE_MOVE=1`. Opcode 43 moves a block. Opcode 40 changes a block's model. Opcode 28 clears a slot. Opcode 71 saves the loaded slot to flash.

## Transports

### Web Bluetooth

The client writes one JSON object to characteristic `cmd`. The server sends chunked notifications on `rsp`. The chunk header is in [ble-gatt.md](ble-gatt.md). Timeouts: dump ops 45 s, other ops 15 s.

### WebSocket

URL: `ws://<host>/ws` (or `wss://<host>:8443/ws` when you use `--https`).

Each frame is one JSON object. The client adds `"id"`. The server returns the same `"id"`.

If you are writing a client that is not the ToneRelay GUI, start with [integrators.md](integrators.md).

```json
{"id":1,"op":"ping"}
{"id":1,"ok":true,"op":"ping","pong":true}
```

HTTP helpers:

- `GET /api/info` — same payload as `{"op":"info"}`
- `GET /api/catalog` — `model_param_index.json`

## ESP32 later

The same static files can go in flash. The ESP32 can run GATT for Android and Wi-Fi for iPhone. Do not port the USB host in this prototype. Keep the JS bundle small. This build is about 66 kB gzip.
