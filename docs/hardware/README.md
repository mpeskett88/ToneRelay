# ToneRelay hardware packet

This directory is the handoff for a **KiCad** agent (or a human PCB designer). It describes a battery-powered USB-host gadget that runs the existing ESP32-P4 firmware in `esp32-p4/` and talks to a Line 6 Helix Floor.

Start here, then read in this order:

1. [kicad-agent-brief.md](kicad-agent-brief.md) — what to produce, what not to invent
2. [requirements.md](requirements.md) — shall / should / must not
3. [block-diagram.md](block-diagram.md) — system and power
4. [pin-map.md](pin-map.md) — firmware-locked GPIOs
5. [schematic-notes.md](schematic-notes.md) — nets, connectors, USB, radio, debug
6. [layout.md](layout.md) — USB HS, SDIO, RF, stackup
7. [mechanical-bom.md](mechanical-bom.md) — enclosure, parts, assembly
8. [bring-up.md](bring-up.md) — first power-on and tests
9. [handoff.yaml](handoff.yaml) — machine-readable copy of the same facts
10. [references.md](references.md) — datasheets and the NANO schematic

Firmware, Helix protocol, and the web GUI are **out of scope** for the KiCad work. The board must boot the current `hxbridge-p4` image without a pin-map fork.

## What this gadget is

ToneRelay is a USB **host**. The Helix Floor is the USB **device** (VID `0x0E41`, PID `0x4248`, USB 2.0 High-Speed, vendor bulk on interface 0, endpoints `0x01` / `0x81`, 512-byte max packet). The phone never talks USB to the Helix. The P4 claims only the vendor interface. USB Audio and HID stay unclaimed.

Wi-Fi 6 (2.4 GHz) and Bluetooth LE come from an **ESP32-C6** coprocessor on SDIO (`esp_hosted`), not from the P4. The P4 has no radio.

Credentials (SoftAP password, home STA password) live in NVS on the P4. Do not hard-code secrets on the PCB, in EEPROM, or on silkscreen.

## Bring-up board this firmware already runs on

Waveshare **ESP32-P4-NANO** (SKU 29026):

- ESP32-P4NRW32 (rev **v3.1** in the lab), 32 MB in-package PSRAM, 16 MB NOR flash
- ESP32-C6-MINI-1 on SDIO
- USB-A = P4 USB 2.0 HS OTG (Helix)
- USB-C = CH343 UART to P4 UART0 (flash/console). Opening that port often **resets** the P4 because DTR/RTS are tied into EN/BOOT. A custom board must not repeat that.

Wiki: [ESP32-P4-NANO](https://docs.waveshare.com/ESP32-P4-NANO)

Schematic: [ESP32-P4-NANO-schematic.pdf](https://files.waveshare.com/wiki/ESP32-P4-NANO/ESP32-P4-NANO-schematic.pdf)

Copy the NANO **C6 SDIO** and **USB-A HS** circuits. Do not copy Ethernet, MIPI, codec, microSD, or PoE.

## Two possible boards

| Board | Intent | CAD difficulty |
| --- | --- | --- |
| **Rev 1 product (required)** | Custom PCB: P4NRW32 + C6-MINI-1 + USB-A host + isolated debug + LiPo | USB HS + SDIO + RF keepout + PMIC |
| NANO power sled (optional later) | Battery + 5 V boost feeding the NANO 5 V header; Helix still uses the NANO USB-A | Easy, does not fix UART reset or USB layout |

Design **Rev 1 product** unless the user explicitly asks only for the sled.

## Where CAD should run

KiCad on a laptop with a display (the Mac already used for ToneRelay setup). Do not install KiCad in Docker on the lab Raspberry Pi. That Pi is the firmware/USB bench: tight disk, no useful GUI, Remote-SSH only.
