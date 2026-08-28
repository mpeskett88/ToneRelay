# BLE GATT service — ToneRelay

The Pi advertises as **ToneRelay**. Chrome and Edge use Web Bluetooth in the web GUI. Safari on iPhone uses the WebSocket path in [web-gui.md](web-gui.md). LightBlue still works for lab checks.

A BLE client discovers the custom service, enables notifications on `rsp`, then writes JSON to `cmd`.

## Identifiers

| Role | UUID |
|---|---|
| Service | `363e0bb2-e8d2-5efd-a0ca-f430385a2b5c` |
| Command (write) | `6bbfcaf0-a29a-5a62-b736-8b5db334d342` |
| Response (notify) | `37470314-79b2-5e4b-a54d-3080f3806886` |
| Status (read/notify) | `87bec7b0-2941-5235-8b5a-fd79587d326c` |

UUIDs are `uuid5(NAMESPACE_DNS, "hxblue.helix-bridge.gatt.{service,cmd,rsp,status}")`.

Pi adapter: `D8:3A:DD:DB:76:0C` (may change if the SD image is cloned; `bluetoothctl show`).

## Response framing

Each notification payload:

```
byte 0        flags: bit0=first chunk, bit1=last chunk
bytes 1–2     total JSON length (big-endian uint16)
bytes 3–4     offset of this chunk (big-endian uint16)
bytes 5–      up to 160 bytes of UTF-8 JSON
```

Reassemble `payload[offset:offset+len]` until the last-chunk bit is set, then `json.loads`.

## Commands (JSON written to `cmd`)

```json
{"op":"ping"}
{"op":"info"}
{"op":"list_presets"}
{"op":"list_presets","setlist":0}
{"op":"select_preset","bank":0,"preset":1,"setlist":0}
{"op":"preset_info"}
{"op":"events"}
{"op":"list_setlists"}
{"op":"list_irs"}
{"op":"select_snapshot","index":0}
{"op":"move_block","from":7,"to":8}
{"op":"list_models"}
{"op":"set_model","block":3,"model_id":"HD2_DistKinkyBoost"}
{"op":"set_model","block":4,"model_id":"HD2_AmpEssexA30","pair":true}
{"op":"clear_block","block":8}
{"op":"save_preset","setlist":0,"index":17,"name":"Essex A30"}
{"op":"set_param","block":4,"param":0,"subslot":0,"float":0.41}
{"op":"get_param","block":4,"param":0}
{"op":"set_bool","block":5,"param":2,"value":true}
{"op":"set_int","block":6,"param":0,"subslot":0,"value":3}
{"op":"set_bypass","block":1,"enabled":false}
{"op":"set_trails","block":7,"value":true}
{"op":"set_global","id":30,"value":8}
{"op":"set_assign","block":0,"value":2}
{"op":"get_assign","block":0}
{"op":"get_state"}
{"op":"topology"}
```

`subslot` is optional and defaults to `0`. Dual cab / Path 1B I/O use `"subslot":1`.

`get_param` reads the loaded preset document. Reply: `{"ok":true,"op":"get_param","block":4,"param":0,"subslot":0,"value":0.33}`. When the HX Edit catalog is loaded, the reply also has `name`, `min`, `max`, `kind`, and `label`.

`set_param` writes a type-30 float (wire value, not the HX Edit label). Essex Drive UI 4.1 is `"float":0.41`. Negative levels use `"float":-6` (JSON number).

`set_global` allowlist: id `30` = Guitar In-Z (0=Auto, 8=1M Ohm); id `134` = Guitar Pad (0=Global, 1=Off, 2=On).

`set_assign` changes Path I/O assignment. Live Essex: Input block `0` value `2` = Guitar; Output block `9` value `2` = None. Wrong values can silence a path.

`get_assign` reads the same type-42 list index from the type-24 dump. Path 1A Input is `"block":0`. Path 1A Output is `"block":9`. Path 1B uses `"subslot":1` on USB 10 (input) or 19 (output). Reply: `{"ok":true,"op":"get_assign","block":0,"subslot":0,"value":2}`. When the catalog is loaded the reply also has `label` and `menu`. Dump reads take a few seconds.

`get_state` and `topology` read the loaded preset. Both replies include `blocks`, `paths`, and `snapshots`. `get_state` also includes `snapshot` (0-based current snapshot) and `{setlist, index, name}` from opcode 23. When the catalog is present, each block also has `model_id`, `model_name`, `category`, and `knobs`, plus `"stereo"` when the firmware has both a mono and a stereo symbol for that model. I/O blocks may include `assign_label` and `assign_menu`. IR Select knobs replace the catalog dashes with names from `list_irs`. The web GUI draws a slot grid; `paths` only decides parked vs live split.

`list_presets` without `setlist` lists the active Floor setlist from `preset_info`. With `"setlist":0`–`7` it lists that setlist's names only.

`list_setlists` reads the eight setlist names (opcode 0 on the control channel). Reply: `{"ok":true,"op":"list_setlists","setlists":[{"index":0,"name":"Factory 1"}, ...]}`.

`list_irs` reads impulse-response slots stored on the device (opcode 13 on the control channel). Reply: `{"ok":true,"op":"list_irs","irs":[{"index":0,"name":"Essex Cab"}, ...]}`. `index` is the 0-based slot. Empty slots may be omitted. This is a directory listing only; it does not transfer IR files.

`list_models` returns the HX Edit effect categories (with shelves and model ids) from the catalog. It does not talk to the Helix. Favourites are not in this list. Each model may include `load` and `load_stereo` (HX Edit DSP percent). The GUI uses those plus each `get_state` block's `load` to dim models that do not fit the remaining path budget. A replace credits the current block. The device can still refuse with **-306**.

If the Helix is powered off, JSON ops that need USB reply `{"ok":false,"error":"helix not connected"}`. The USB daemon stays up and opens a new session when the Floor enumerates again.

`select_snapshot` takes `"index":0`–`7` (opcode 88). `move_block` takes `"from"` and `"to"` USB slots 0–39 on one DSP (opcode 43, keys 75/76). Input, output, split, and merge are refused. `set_model` changes what a slot is (opcode 40, after a type-78 select). Pass `"model"` (Helix.sym number) or `"model_id"` (catalog id). Optional `"stereo":true|false` selects the stereo or mono firmware symbol when both exist for that id. Amp+Cab uses `"pair":true` or `"paired"` / `"paired_id"`. `clear_block` empties a slot (opcode 28). Input, output, split, and merge are refused. The GUI opens this from the inspector title or from an empty cell (category, then Mono/Stereo/Legacy when present, then models). `get_state` blocks include `"stereo"` when the catalog has both widths. Device error **-306** is DSP budget. The GUI error banner clears after five seconds. `save_preset` writes the edit buffer to a setlist slot (opcode 71, keys 107/108/109). Omit `setlist`, `index`, or `name` to use opcode 23 identity. `events` returns `{dirty, setlist, index}` from drained notifications.

Successful `list_presets` response:

```json
{"ok":true,"op":"list_presets","count":128,"presets":[{"index":0,"name":"US Double Nrm"}, ...]}
```

`select_preset` loads a preset. `bank`/`preset` are the 8×16 fields inside one setlist (Helix Floor: 128 slots). Optional `"setlist":0`–`7` selects which setlist (default 0).

## Security

The current server accepts **unencrypted writes** so a laptop can test without pairing. That is a lab default only. Before any untrusted client:

- Change the command characteristic flags to `encrypt-write` (and prefer bonding).
- Keep `list_presets` readable without encryption if you want; `select_preset` must not be.

## Run

```bash
# USB ops used by the server:
export HXBRIDGE_CLI=$HOME/hxblue/openhx/target/debug/openhx-cli
python3 $HOME/hxblue/hxbridge/gatt_server.py
```

Needs BlueZ `bluetoothd --experimental` (already configured) and permission to talk to `org.bluez` on the system bus. If `RegisterAdvertisement` fails with access denied, run the server with sudo or add a D-Bus policy for user `admin`.

Stop with Ctrl-C; the process unregisters the advertisement and GATT application.

systemd unit `hxbridge-gatt.service` starts the same process. Helix USB must be on the Pi, not a Mac.

## LightBlue (Mac)

1. On the Pi: Helix USB connected. Then:

   ```bash
   sudo systemctl start hxbridge-gatt.service
   systemctl is-active hxbridge-gatt.service
   journalctl -u hxbridge-gatt.service -n 30 --no-pager
   ```

   You want `active` and a log line that the advertisement registered.

2. Open LightBlue. Scan. Connect to **ToneRelay** (Pi address is often `D8:3A:DD:DB:76:0C`).

3. Open the custom service `363e0bb2-e8d2-5efd-a0ca-f430385a2b5c`.

4. On **rsp** (`37470314-79b2-5e4b-a54d-3080f3806886`): enable **Listen / Notify**. Do this before every write.

5. On **cmd** (`6bbfcaf0-a29a-5a62-b736-8b5db334d342`): write UTF-8 text (not hex). Start with:

   ```
   {"op":"ping"}
   ```

6. Read the notify. Byte 0 has flags. Bytes 1–2 are total length (big-endian). Bytes 3–4 are offset. Bytes 5+ are JSON. For `ping` the JSON starts at byte 5 and is one chunk. You should see `{"ok":true,"op":"ping","pong":true}`.

7. Then write:

   ```
   {"op":"info"}
   ```

   Check `"usb":true`. If it is false, the Helix is not on this Pi.

8. Load the Essex preset on the Helix (or write `{"op":"select_preset","bank":0,"preset":1}` only if slot 1 is Essex on the **active setlist**). Watch the Helix screen.

9. Write Essex Drive (USB block 4, param 0). UI 4.1 = wire 0.41:

   ```
   {"op":"set_param","block":4,"param":0,"float":0.41}
   ```

   The Drive knob must move. Then read it back (one notify; JSON from byte 5):

   ```
   {"op":"get_param","block":4,"param":0}
   ```

   `"value"` must match the write (Drive 4.1 → about `0.41`). Dump reads take a few seconds.

10. Dual cab 2 (subslot 1), Mic list index 0:

    ```
    {"op":"set_int","block":6,"param":0,"subslot":1,"value":0}
    ```

11. Skip `list_presets` in LightBlue until ping works. That reply is large and arrives as many binary chunks. LightBlue will not join them for you.

If connect fails: on the Pi run `bluetoothctl show` and confirm Powered: yes. Stop other GATT apps. Pairing is not required in this lab build (unencrypted writes).

## Laptop client sketch (Bleak)

```python
# pip install bleak
import asyncio, json
from bleak import BleakClient, BleakScanner

SVC = "363e0bb2-e8d2-5efd-a0ca-f430385a2b5c"
CMD = "6bbfcaf0-a29a-5a62-b736-8b5db334d342"
RSP = "37470314-79b2-5e4b-a54d-3080f3806886"

async def main():
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: SVC.lower() in [u.lower() for u in (ad.service_uuids or [])]
        or (d.name or "") == "ToneRelay"
    )
    chunks = bytearray()
    done = asyncio.Event()

    def on_notify(_handle, data: bytearray):
        flags, total, offset = data[0], int.from_bytes(data[1:3], "big"), int.from_bytes(data[3:5], "big")
        if flags & 0x01:
            chunks.clear()
        payload = data[5:]
        if len(chunks) < offset + len(payload):
            chunks.extend(b"\x00" * (offset + len(payload) - len(chunks)))
        chunks[offset:offset + len(payload)] = payload
        if flags & 0x02:
            done.set()

    async with BleakClient(dev) as client:
        await client.start_notify(RSP, on_notify)
        await client.write_gatt_char(CMD, b'{"op":"list_presets"}')
        await asyncio.wait_for(done.wait(), 30)
        print(json.loads(bytes(chunks)))

asyncio.run(main())
```
