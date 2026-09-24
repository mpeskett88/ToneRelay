# KiCad agent brief

You are designing a PCB for ToneRelay, not rewriting firmware and not talking to a Helix.

## Deliverables

Produce a KiCad **8 or 9** project (not a screenshot of a schematic):

```
hardware/tonerelay-p4/
  tonerelay-p4.kicad_pro
  tonerelay-p4.kicad_sch
  tonerelay-p4.kicad_pcb
  tonerelay-p4.kicad_prl
  fp-lib-table
  sym-lib-table
  libraries/          # only symbols/footprints you had to draw
  fabrication/
    bom.csv
    gerbers/          # after DRC is clean
    cpl.csv           # pick-and-place, if assembled
  erc.txt             # ERC report
  drc.txt             # DRC report
```

Also update this packet if you discover a pin conflict. Do not silently change firmware-locked nets.

## Non-negotiables

1. Read every file in `docs/hardware/` and `esp32-p4/sdkconfig.defaults` before placing a part.
2. Keep the SDIO map in [pin-map.md](pin-map.md). If a trace cannot reach those GPIOs, stop and report. Do not remap in CAD and assume firmware will follow.
3. Helix USB is **High-Speed host** on the P4 dedicated HS PHY (`DP` / `DM`), not ESP32-S3 full-speed GPIO USB, not a USB hub, not the P4 full-speed OTG pins as the Helix port.
4. The Helix is self-powered (its own 9 V). This board must **not** try to power the Helix. It must still present 5 V on USB-A **VBUS** so the Helix enumerates.
5. Debug UART must **not** reset the P4 when a host opens the serial port. Auto-download (DTR/RTS → EN/BOOT) is a jumper, default **open**.
6. Chip revision: **ESP32-P4 v3.0 or later** (lab unit is v3.1; firmware sets `CONFIG_ESP32P4_REV_MIN_301`). Do not design around v1.0 / v1.3 except for optional compatibility parts listed in Espressif’s guide.
7. Use **modules** for RF: ESP32-C6-MINI-1 (or MINI-1U). Do not chip-down the C6 on rev 1.
8. Prefer **ESP32-P4NRW32** (32 MB PSRAM in package) plus external 16 MB NOR flash, following Espressif’s P4 reference schematic for rails, crystals, and flash. A pre-certified P4 module is acceptable if it exposes HS `DP`/`DM`, UART0, and the SDIO GPIOs below.
9. Four-layer PCB. Two-layer is not acceptable for USB HS + SDIO.
10. No Wi-Fi passwords, tokens, or private keys anywhere in the design.
11. Do not add Ethernet, MIPI DSI/CSI, audio codec, speaker, microphone, microSD, or PoE. The NANO has them; this product does not.
12. Do not put a USB hub between the P4 HS PHY and the Helix.
13. Do not use ESP32-S3, C3, C5-only, or C6-only as the USB host. Those parts are not USB 2.0 HS hosts. Helix bulk is 512 bytes at High-Speed.
14. Bluetooth Classic / A2DP is not a requirement. C6 is BLE + Wi-Fi 6 2.4 GHz only.
15. When Espressif and this packet disagree on P4 power pins, crystals, or USB PHY decoupling, **Espressif wins**. When they disagree on SDIO GPIO numbers, **this packet wins** (firmware lock).

## Sources of truth

| Topic | Source |
| --- | --- |
| SDIO GPIOs, UART0, reset polarity | [pin-map.md](pin-map.md), `esp32-p4/sdkconfig.defaults` |
| USB host behaviour | `esp32-p4/components/tonerelay/usb.c`, `esp32-p4/README.md` |
| Flash size | `esp32-p4/partitions.csv` (16 MB device, 6 MB app + 8 MB LittleFS) |
| C6 coprocessor | `esp_hosted` ~2.12.13, `CONFIG_SLAVE_IDF_TARGET_ESP32C6` |
| P4 electrical | [ESP32-P4 datasheet](https://documentation.espressif.com/esp32-p4_datasheet_en.pdf), [P4 hardware design guidelines](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32p4/esp-hardware-design-guidelines-en-master-esp32p4.pdf), [schematic checklist](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32p4/schematic-checklist-esp32p4.html) |
| NANO reference (copy USB-A + C6 only) | [NANO schematic PDF](https://files.waveshare.com/wiki/ESP32-P4-NANO/ESP32-P4-NANO-schematic.pdf) |
| C6 module | ESP32-C6-MINI-1 datasheet / module HW guide (antenna keepout) |

Do not invent P4 ball names. Open the datasheet for `DP`, `DM`, `VDD_USBPHY`, `CHIP_PU`, flash pins, and LDO pins.

## Design sequence

1. Block diagram on the schematic cover sheet (same boxes as [block-diagram.md](block-diagram.md)).
2. Power tree first, then P4 + flash + crystal, then HS USB-A, then C6 SDIO, then debug UART, then battery, then buttons/LEDs/test points.
3. ERC.
4. Floorplan: USB-A connector and HS PHY on one edge; C6 antenna on the opposite edge or a keepout corner; battery connector away from USB ESD.
5. Length-matched USB HS and SDIO before pouring analog doodles.
6. DRC, then gerbers.

## Fabrication target

Default: **JLCPCB** 4-layer, 1.6 mm, ENIG or HASL, min 0.15 mm trace/space if the USB pair needs it, 0.3 mm vias OK, no HDI on rev 1. Prefer LCSC basic parts for PMICs, ESD, and USB-UART. C6-MINI-1 and P4NRW32 may be “extended” or customer-supplied; say so on the BOM.

## When to stop and ask

Stop and ask the human (do not guess) if:

- HS `DP`/`DM` cannot be routed as a 90 Ω pair with the length match in [layout.md](layout.md)
- SDIO cannot keep the firmware GPIO map
- A chosen P4 module hides HS USB or the SDIO pins
- Battery chemistry or enclosure size is unspecified and changes the board outline
- You want to add a USB hub, mux, or Type-C for the Helix port

## Out of scope

- Flashing a Helix, sending Helix vendor packets, or changing `hx-usb`
- AirPlay / Bluetooth audio playback into Helix USB Audio
- KiCad on the lab Pi
- Chip-down C6 RF
- 5 GHz Wi-Fi
- Powering the Helix from the LiPo
