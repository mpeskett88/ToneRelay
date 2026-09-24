# Bring-up and test

Do this on the lab Pi or a laptop. Do not use the Helix as a power supply. Do not send new vendor-bulk packets while proving the PCB.

## Before first power

1. Visual: antenna keepout clear, USB-A soldered, polarity on JST.
2. Resistance: `V5` to GND and `3V3` to GND not shorted.
3. `AUTO_DL` jumper **off**.
4. No Helix cable yet.

## Rails

1. USB-C 5 V only, no cell. Confirm charger VIN and, if power-path exists, `V5` after the power switch.
2. Fit a cell or a 3.7 V current-limited bench supply on JST (correct polarity).
3. Measure `V5` = 5.0 V ± 5 %, `3V3` = 3.3 V ± 3 %, `VDD_USBPHY` ≈ 3.3 V, `VBUS_OUT` = 5 V with nothing in USB-A.
4. Current from 5 V with no Helix: record it (expect hundreds of mA once P4 and C6 boot). If it is amps, stop.

## Programming

1. USB-C enumerates a USB-UART (`/dev/ttyACM*` or `/dev/ttyUSB*`).
2. Open the port. The P4 must **not** reset. If it does, DTR/RTS are still wired — fix that before any Helix work.
3. Hold BOOT, tap RESET, flash the existing image (from `esp32-p4/README.md`):

```bash
. /home/admin/esp/esp-idf-v5.5.3/export.sh
cd /home/admin/hxblue/esp32-p4
espflash flash -p PORT --chip esp32p4 --non-interactive \
  --partition-table partitions.csv --partition-table-offset 0x8000 \
  target/riscv32imafc-esp-espidf/debug/hxbridge-p4
```

Replace `PORT` with the UART device. Do not skip `--partition-table` (8 MB catalog LittleFS).

4. Serial log (only after auto-reset is proven off, or use a button reset): USB host start, then C6, HTTP. SoftAP `ToneRelay`.

## Radio

1. Phone or laptop sees `ToneRelay` (open SoftAP until the wizard sets a password).
2. `http://192.168.4.1` or `http://tonerelay.local` loads the SPA.
3. Optional: join 2.4 GHz STA. 5 GHz APs will not appear (C6).

## Helix USB

Helix is already on 9 V. This board is the **only** USB host.

1. Plug Helix into USB-A **after** the gadget has booted (firmware also enumerates a hot-plug).
2. Log: `HX device pid=4248` then `usb session opened`.
3. Editor: preset list / `get_state`.
4. If the Helix goes silent: unplug **Helix 9 V**, wait for boot, replug USB. A USB replug alone may not recover. That is a known Helix behaviour, not an excuse for a 3V3 dip — check 3V3 with a scope during the failure.

Do not run HX Edit on a Mac against the same Helix at the same time.

## Failures that are hardware

| Symptom | Likely PCB |
| --- | --- |
| UART open resets P4 | DTR/RTS still on EN/BOOT |
| Enumerates as Full-Speed or not at all | HS pair, ESD capacitance, missing `VDD_USBPHY` |
| No `pid=4248` | VBUS off, DP/DM swapped, not HS |
| C6 0.0.0 forever / no SoftAP | SDIO map, GPIO54, keepout, 3V3 |
| Wi-Fi dies when Helix traffic starts | 3V3 dip, SDIO next to USB, boost noise into CLK |
| Helix needs 9 V pull after every flash | UART still resetting P4 mid-session |

## What not to test on rev 1 hardware

- Helix USB Audio / AirPlay
- BLE until firmware re-enables NimBLE (hosted HCI may still be skipped in software)
- Factory-reset button (no firmware yet)
- Runtime marketing numbers without a current log
