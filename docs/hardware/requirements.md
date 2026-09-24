# Requirements

Product: **ToneRelay P4** rev 1 — a small, battery-powered USB 2.0 High-Speed **host** that runs the existing `hxbridge-p4` firmware and presents Wi-Fi (SoftAP + optional STA) plus Bluetooth LE to a phone. The USB device on the other end of the USB-A cable is a Line 6 Helix Floor (firmware 3.80 in the lab).

Priority: **reliable Helix vendor-bulk session first**, then radio, then battery runtime. Pretty LEDs are last.

## Actors and ports

| Port | Role | Connects to |
| --- | --- | --- |
| USB-A receptacle | USB 2.0 HS **host** | Helix Floor USB |
| USB-C receptacle | 5 V charge + UART debug (not Helix) | Laptop / Pi `espflash` |
| 2.4 GHz antenna (on C6 module) | Wi-Fi 6 + BLE | Phone / home AP |
| JST (or similar) | 1S Li-ion | Pack with protection |
| Helix 9 V inlet | Not on this board | Helix power supply only |

The Helix accepts **one USB host at a time**. Unplug HX Edit before using this gadget.

## Functional requirements

### USB host (shall)

- Enumerate a USB 2.0 High-Speed device with a composite configuration larger than 256 bytes (Helix config is above the IDF default control-transfer size; firmware already sets 4096).
- Provide a dedicated bulk pair at 512-byte max packet size (Helix `EP 0x01` OUT, `0x81` IN).
- Drive 5 V on USB-A VBUS whenever the board is on, through a current-limited load switch. Default ON.
- Leave VBUS current budget for a **self-powered** device (Helix draws its analog power from 9 V). Design the switch for at least 500 mA continuous, 1 A short-circuit limit. Do not size the battery as if it must run the Helix DSP.
- Use the P4 **High-Speed OTG PHY** (`DP` / `DM`). Firmware `usb.c` uses the IDF USB host driver (DWC, 16 host channels, balanced FIFO). Full-Speed PHYs on GPIO24–27 are not the Helix port.
- Place ESD on D+/D− at the connector with **≤ 1 pF** extra capacitance (Espressif HS rule).
- Do not reset, hub, or re-enumerate through an intermediate USB IC.

### Radio (shall)

- ESP32-C6 (module) as `esp_hosted` SDIO slave: Wi-Fi 6 **2.4 GHz only**, Bluetooth 5 LE.
- SDIO 4-bit on P4 GPIOs **14–19**, slave reset on P4 **GPIO54**, reset **active high** (`CHIP_PU`).
- SoftAP SSID `ToneRelay` is firmware. Hardware only needs a working C6 and antenna keepout.
- BLE advertising name `ToneRelay` is firmware. Hardware must not force Classic BR/EDR.

### Compute and memory (shall)

- ESP32-P4 HP clock 360 MHz capable (firmware default).
- In-package or onboard PSRAM (NANO: 32 MB). Firmware uses SPIRAM malloc. USB DMA buffers stay in **internal RAM** (`CONFIG_USB_HOST_DWC_DMA_CAP_MEMORY_IN_PSRAM` is unset). That is a firmware/layout-of-SRAM issue, not a reason to omit PSRAM.
- 16 MB NOR flash mapped as: NVS, phy, 6 MB factory app, 8 MB LittleFS catalog (`esp32-p4/partitions.csv`).

### Debug and programming (shall)

- USB-C enumerates a USB-UART (CH343, CH340, or CP2102N) to P4 UART0: TX **GPIO37**, RX **GPIO38** (NANO map, firmware console/`espflash`).
- Opening the serial port must **not** toggle `CHIP_PU` / `EN` or `BOOT`. Provide an `AUTO_DL` jumper or switch, default **off**.
- Separate `BOOT` (download) and `RESET` buttons, like the NANO, for manual download.
- Test points: 3V3, 5V, VBUS_OUT, GND, UART0 TX/RX, `CHIP_PU`, GPIO54, USB HS DP/DM (or series-resistor pads).

### Battery (shall)

- 1S Li-ion/LiPo with **protection PCB** in the pack (OV/UV/OC). On-board charger does not replace the pack protector.
- USB-C 5 V input charges the cell. Helix USB-A is not a charge port.
- Boost to 5 V for P4 5 V input and USB-A VBUS.
- Undervoltage cut-off that drops 5 V (and therefore VBUS) before the cell is damaged.
- Power switch that kills the boost output (hard off).

### User I/O (should)

Firmware does not drive these yet. Still place them and label nets for a later firmware patch:

| Function | Suggested P4 GPIO | Notes |
| --- | --- | --- |
| Factory NVS wipe | GPIO53, button to GND, pull-up | Hold 3 s later in firmware |
| LED: power | 5 V or 3V3 via resistor | Hardware-only, on with rails |
| LED: radio | GPIO45 | Firmware later |
| LED: USB session | GPIO46 | Firmware later |
| LED: battery / charge | Charger STAT pin and/or GPIO47 | |
| VBUS enable override | GPIO48, default pulled so VBUS is ON | Optional FET control |

If a suggested GPIO collides with the P4 package or flash straps, pick another **unused** GPIO and document it in `pin-map.md`. Do not reuse 14–19, 24–27 (if USB-JTAG pads are fitted), 37–38, or 54.

### Mechanical (should)

- USB-A on a panel edge with a connector that can take a guitar-cable yank (through-hole USB-A preferred).
- Pedalboard-friendly outline: target ≤ 100 mm × 70 mm excluding the battery, or a stacked 18650 bay.
- C6 antenna keepout per module drawing, not under a metal lid without a plastic window.

## Explicit non-requirements (must not)

- Bus-power the Helix analog section or its 9 V rail.
- Bluetooth Classic A2DP, AirPlay, or USB Audio isochronous playback (future software; do not add DACs or extra USB audio gadgets).
- 5 GHz Wi-Fi.
- Second USB host port.
- USB device/gadget mode on the Helix connector.
- Secure element, TPM, or baked-in certificates.
- PoE, Ethernet PHY, LCD, camera, speaker, microphone, microSD.

## Lab facts the PCB must respect

These are observed on the NANO + Helix Floor 3.80, not theory:

- Opening the NANO USB-C UART often **resets the P4** (DTR/RTS). After that, the Helix vendor session can wedge. Recovery is often **unplug Helix 9 V**, wait for boot, then USB; a USB replug alone is not enough.
- Helix bulk IN can burst for seconds. Firmware already lengthened the task WDT to 30 s and parks IN URBs. The board must not brown out 3V3 or `VDD_USBPHY` during those bursts.
- USB DMA from PSRAM was rejected in firmware. Keep HS PHY power clean; do not starve internal RAM rails.
- Start USB host **before** C6 SDIO traffic (firmware delays 400 ms). A weak SDIO reset line (GPIO54 / `CHIP_PU`) that glitches at power-up will desynchronize Wi-Fi.
- C6 hosted 2.12.13 VHCI HCI reset has been unresponsive in firmware (`BLE skipped`). That is software. Still route SDIO and C6 reset correctly so BLE can be re-enabled later.
- FIFO bias on the P4 HS DWC must remain **balanced** in firmware so a ~272-byte OUT frame fits. Hardware cannot fix a wrong FIFO Kconfig; it can ruin HS eye with extra capacitance.

## Power budget (until measured)

Do not claim a runtime. Before locking the cell, measure 5 V current on a NANO with Helix enumerated, SoftAP up, and the editor WebSocket open.

Until that number exists, design silicon for:

- 5 V rail capable of **2 A** peak (Wi-Fi TX + P4 + VBUS)
- Continuous **1 A** without the inductor saturating
- Inrush on VBUS connect (Helix VBUS capacitance) without collapsing 3V3

A 18650 ~3500 mAh 1S pack is the default mechanical assumption. If measured 5 V current is 0.8 A average, runtime is on the order of a few hours, not a full gig. Say so on the silkscreen only as “Li-ion 1S”, not a hour rating.

## Quality

- ERC and DRC clean.
- USB HS pair: 90 Ω differential, length match ≤ 0.15 mm, no stubs, GND plane under the pair with no splits.
- SDIO: length-matched as a group, series 22–33 Ω at the P4 end, keep away from USB DP/DM and the C6 antenna.
- All connectors have GND pins and mounting holes where the part allows.

## Compliance (should, not a cert program)

- USB 2.0 HS layout per Espressif, not a USB-IF cert on rev 1.
- 2.4 GHz: use a **pre-certified C6 module** so the first boards can run as a modular transmitter under the module’s conditions (antenna keepout, no extra metal on the antenna).
- Battery: follow the charger IC datasheet; include a PCM pack; no unfused cell-to-board wiring.
