# Use ToneRelay as a network backend

This page is for authors of another Helix or HX editor who want LAN (or
optional Bluetooth) access to a device on a Raspberry Pi, without using the
ToneRelay React GUI.

You do not load a ToneRelay SDK or slot a plugin into this tree. You open a
socket, send JSON, and keep your own UI.

Verified on Helix Floor firmware 3.80. The default Pi install starts the USB
daemon and HTTP/WebSocket only. It does not start BLE GATT.

## What you get

The Pi owns the USB session. Your app is a client:

```
Your app  →  WebSocket JSON (ws://HOST/ws)
               →  hxbridge/http_server.py
                    →  Unix socket /tmp/hxbridge-usb.sock
                         →  hxbridge-usb (TonePush session)
                              →  Helix
```

The same JSON objects are the BLE GATT payload when that server is running.
GATT chunk framing is in [ble-gatt.md](ble-gatt.md).

If your project already talks USB (TonePush, FretWire, and similar), you can
instead implement this JSON on top of your own session and ignore
`hxbridge-usb`. The useful part is the command contract, not the React app.

## Run the relay

Install on the Pi as in the [README](../README.md). That builds the GUI as
well. Your client only needs the daemon and `http://HOST/ws`.

The HTTP process serves the GUI from `hxbridge/static/` when that build
exists. If `index.html` is missing, `/` returns HTTP 503. `/ws` still works.

Talk to the Pi on a trusted LAN only. There is no login. Traffic is HTTP
unless you start the server with `--https`. Do not port-forward this to the
internet. The Helix accepts one USB host: stop `hxbridge-usb` before you plug
the Floor into a computer running HX Edit or another USB editor.

## WebSocket

URL: `ws://HOST/ws` (or `wss://HOST/ws` if you serve TLS). `HOST` is the Pi
hostname or address, plus `:<port>` when HTTP is not on port 80.

Each frame is one JSON object. Include `"op"`. Include `"id"` (a number) if
you send more than one command at a time; the reply copies that `"id"`.

```json
{"id":1,"op":"ping"}
{"id":1,"ok":true,"op":"ping","pong":true}
```

A command that needs the Helix while it is unplugged returns
`{"ok":false,"error":"helix not connected"}`. The USB daemon stays running and
opens a new session when the Floor enumerates again.

Dump-style ops (`get_state`, `list_presets`, `list_models`, and others in
[web-gui.md](web-gui.md)) can take tens of seconds. The ToneRelay GUI uses
45 s for those and 15 s for the rest.

Minimal client (`pip install websockets`):

```python
import asyncio
import json
import websockets

async def main():
    uri = "ws://PI_HOST/ws"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"id": 1, "op": "ping"}))
        print(json.loads(await ws.recv()))
        await ws.send(json.dumps({"id": 2, "op": "info"}))
        print(json.loads(await ws.recv()))

asyncio.run(main())
```

Replace `PI_HOST` with the address the installer printed, including the port
when it is not 80.

HTTP helpers on the same listener:

- `GET /api/info` — same body as `{"op":"info"}`
- `GET /api/catalog` — ToneRelay's `model_param_index.json` (not HX Edit
  resources)

## Commands

The full op list and field notes are in [ble-gatt.md](ble-gatt.md). Layout
fields on `get_state` are in [web-gui.md](web-gui.md).

Every command is an object with `"op"`. Successful replies set `"ok": true`.
Failures set `"ok": false` and `"error"`. Device error **-306** means the
path does not have enough DSP for that model.

These ops exist today: `ping`, `info`, `preset_info`, `list_presets`,
`select_preset`, `select_snapshot`, `events`, `list_setlists`, `list_irs`,
`list_models`, `move_block`, `set_model`, `clear_block`, `save_preset`,
`set_param`, `get_param`, `get_state`, `set_bool`, `set_int`, `set_bypass`,
`set_trails`, `set_global`, `set_assign`, `get_assign`, `topology`.

`set_param` uses wire values, not HX Edit knob labels (Essex Drive UI 4.1 is
`"float": 0.41`). `list_models` and named knobs need the HX Edit catalog on
the Pi; see the README. `save_preset` writes the edit buffer to flash.

## Bluetooth

The default install does not enable GATT. The lab unit is
`scripts/hxbridge-gatt.service`. Writes are not encrypted. Web Bluetooth
needs HTTPS; Safari on iPhone does not expose Web Bluetooth, so iPhone
clients should use the WebSocket path.

Service UUID `363e0bb2-e8d2-5efd-a0ca-f430385a2b5c`. Advertised name
**ToneRelay**. Enable notify on `rsp` before you write JSON to `cmd`. Large
replies arrive as 160-byte chunks; see [ble-gatt.md](ble-gatt.md).

## Code in this repository

You can ignore the rest of the tree. Relay-related paths:

| Path | Role |
|---|---|
| `crates/hxbridge-usb/` | USB daemon; JSON over the Unix socket |
| `vendor/tonepush/` | Vendored TonePush crates (`hx-proto`, `hx-usb`, `hx-catalog`) |
| `hxbridge/http_server.py` | HTTP + WebSocket |
| `hxbridge/protocol.py` | Forwards JSON to the daemon |
| `hxbridge/gatt_server.py` | Optional BLE |
| `docs/ble-gatt.md` | Ops and GATT framing |
| `web/` | ToneRelay GUI (optional client) |

`openhx/`, `captures/`, and `firmware/` are lab material, not the network
API.
