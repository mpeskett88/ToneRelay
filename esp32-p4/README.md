# ToneRelay on Waveshare ESP32-P4-NANO

USB-host firmware that runs the same Helix session (`hx-usb`) as the Pi daemon, then serves the ToneRelay GUI over SoftAP/STA and the existing BLE GATT service.

The P4 talks to the Helix on the **USB-A** OTG high-speed port. The onboard **ESP32-C6-MINI-1** provides Wi-Fi 6 and Bluetooth 5 over SDIO (CLK 18, CMD 19, D0–D3 14–17, RESET 54). Wi-Fi credentials and the ToneRelay hotspot password are stored in NVS only. They are never compiled in. Line 6 catalog JSON is not in firmware; you copy it from an HX Edit Resources folder onto flash during setup.

## Flash from the Pi

USB-C on the NANO is the UART programming port (often a WCH CH343). It must enumerate as `/dev/ttyACM*` or `/dev/ttyUSB*` before flashing. A charge-only cable will not show a serial device. Opening that UART often resets the P4.

```bash
. /home/admin/esp/esp-idf-v5.5.3/export.sh
cd /home/admin/hxblue/web && npm run build
cd /home/admin/hxblue/esp32-p4
cargo build
espflash flash -p /dev/ttyACM0 --chip esp32p4 \
  --partition-table partitions.csv --partition-table-offset 0x8000 \
  target/riscv32imafc-esp-espidf/debug/hxbridge-p4
```

Pass `--partition-table` so the 8MB LittleFS `catalog` slice is created. Without it, espflash may treat the whole flash as the app and catalog mount fails. `sdkconfig` and `target/` are local build products and are gitignored. App-only reflash keeps the catalog partition. A full erase wipes NVS and the catalog; run the wizard again.

## First-time setup (laptop)

First boot raises an **open** SoftAP named **ToneRelay**. After you set a password it is WPA2. The wizard runs until the hotspot is secured **and** the catalog is on flash. A saved home network that is down is fallback, not setup.

1. Join `ToneRelay` from a **laptop**. Open **http://192.168.4.1** or **http://tonerelay.local**.
2. Set an 8–63 character WPA2 password for the ToneRelay hotspot (needed when you are away from home). Applying it drops the current SoftAP client — reconnect to ToneRelay with that password and continue.
3. Optionally scan and join a **2.4 GHz** home network (ESP32-C6 radio), or skip to the catalog. The page stays on ToneRelay and shows the STA IP plus `http://tonerelay.local` before you leave the hotspot. 5 GHz networks will not appear. Android Chrome often fails `.local`; use the IP.
4. Pick the HX Edit catalog files (not the installer). Typical paths:
   - Windows: `C:\Program Files (x86)\Line6\HX Edit\` — pick the `res` folder
   - macOS: `/Applications/Line6/` — pick the **HX Edit** app (it is a folder; `Contents/Resources` is inside)
5. The board stores allowlisted JSON (`HX_ModelCatalog.json`, `Helix.sym`, `HelixControls.json`, `*.models`). Artwork (`icons_*`) is skipped. Then open the editor.

Later: `http://tonerelay.local` on the LAN, or the ToneRelay hotspot at `http://192.168.4.1` if home Wi-Fi is gone. SoftAP stays up in APSTA. STA retries forever with backoff.

Web Bluetooth in Chrome requires HTTPS (or localhost). The SoftAP is plain HTTP, so first-time Wi-Fi is this wizard, not Web Bluetooth. After the board is on a LAN you can still use LightBlue / nRF Connect against the **ToneRelay** GATT service, or Chrome Web Bluetooth from an HTTPS page.

### Serial (USB-C UART)

```
wifi MyNetwork mypassword
wifi "Name With Spaces" mypassword
wifi-forget
```

The password is not logged. `wifi-forget` clears the **home STA** credentials only. It does not remove the ToneRelay hotspot password.

## Helix USB

Plug the Helix into the P4 **USB-A** port. After setup, the editor shows a modal if the Helix is unplugged. Logs should show `HX device pid=4248` then `usb session opened`. Only vendor interface 0 is claimed (audio/HID are left alone). The session still does the claim/release/claim dance and posted IN read from `hx-usb`. If the Helix was already wedged, pull its **9V** — a USB replug is not enough.

## BLE

The peripheral name is **ToneRelay**, with the same service/characteristic UUIDs and 160-byte chunk framing as the Pi `gatt_server.py`. Pairing is not required (same lab policy as the Pi).

## Custom PCB

A KiCad handoff for a battery-powered board that keeps this firmware's SDIO/USB pin map is in [docs/hardware/README.md](../docs/hardware/README.md).
