# Schematic notes

Net names in `code` must appear on the KiCad schematic. Power flags on every rail.

## Sheet split (suggested)

1. Cover / block diagram
2. Power + battery
3. ESP32-P4NRW32 + flash + crystals
4. USB-A HS host
5. ESP32-C6-MINI-1 + SDIO
6. USB-C charge + UART debug + buttons + LEDs

## Power and battery

### USB-C input

- USB-C receptacle, **device** (this board is the device on USB-C).
- CC1 and CC2 each 5.1 kΩ to GND (default USB2 5 V). No PD IC required on rev 1.
- ESD on USB-C D+/D− (UART bridge) can be a cheaper FS TVS; this is not the Helix pair.
- `VBUS_C` → charger VIN through a fuse (polyfuse ~1.5 A).

Do not connect USB-C D+/D− to the P4 HS PHY.

### Charger and cell

- 1S Li-ion charger (example class: TP4056-style is too weak and poorly protected; prefer a JEITA-capable IC such as BQ24075/BQ24232 or a modern 1 A+ charger with power-path). Power-path is useful: USB-C can run the boost while the cell is missing or empty.
- Charge current ~750 mA–1 A unless the cell is smaller.
- JST-PH 2 mm (or JST-XH) `BAT+` / `BAT−`. Mark polarity on silkscreen. Series connector that cannot reverse if you can find one.
- Pack must include a protection PCB. On-board: charger OC and a fuse on `BAT+`.

### Boost and 5 V

- Boost 3.0–4.2 V → 5.0 V, 2 A class, 2 MHz or so is fine.
- Enable pin on the **power switch** (slide or latching), so off is a true rail collapse.
- After the switch: `V5`. Bulk 22–47 µF plus ceramics.
- From `V5`:
  - P4 5 V input (as Espressif shows)
  - C6 3V3 regulator input if C6 is not fed from P4’s 3V3 (prefer **one** 3V3 source rated for P4 + C6; NANO uses a shared `ESP_3V3`)
  - USB-A VBUS switch input

### USB-A VBUS

- Load switch with current limit (example class: NANO uses a DIO7003-style switch plus a P-FET; a single current-limited switch IC is cleaner).
- Net `VBUS_OUT` to USB-A pin 1.
- Soft-start so Helix VBUS capacitance does not collapse `V5`.
- `VBUS_EN` pulled up so the switch is ON with no firmware.
- TVS 5 V on `VBUS_OUT` to GND.

### P4 rails

Copy Espressif’s P4NRW32 reference, including:

- `VDD_USBPHY` capacitors 10 nF + 0.1 µF + 4.7 µF **at the pin**
- Optional 0 Ω in series on `VDD_USBPHY` for bring-up
- Chip rev ≥ v3.0: 1 MΩ HS `DP` pulldown is optional (compatibility). Lab silicon is v3.1.

Measure 3V3 with a scope during Helix IN bursts on first boards. If it dips, add bulk at the P4 3V3 pin, not at the far USB connector.

## ESP32-P4

- Part: **ESP32-P4NRW32** (32 MB PSRAM in package) or a module that is that chip plus flash.
- External **16 MB** NOR (W25Q128 or as Espressif specifies). Firmware partition table needs that size.
- Crystals: copy Espressif (typically 40 MHz for P4; confirm datasheet). 32.768 kHz optional; NANO wires GPIO0/1 to 32K with 0 Ω options.
- `CONFIG_ESP32P4_REV_MIN_301` in firmware: do not buy v1.x remainder stock.

## USB-A High-Speed

Copy the NANO USB type-A idea, not its extra Ethernet:

- Through-hole USB-A, D− = `USB_HS_DM`, D+ = `USB_HS_DP`
- 0 Ω or 2.2–10 Ω series on DP/DM **at the PHY**, pads in line with the pair (no stubs)
- ESD array **at the connector**, extra C ≤ 1 pF (examples: ESD7104, RClamp0524P, or a 2-line HS USB ESD; check the datasheet capacitance)
- No stub to a test header on DP/DM. If you need a probe point, use a 0 Ω in the series pad.

Common-mode choke: skip on rev 1 unless EMI fails. A bad choke ruins HS.

## ESP32-C6-MINI-1

- ESP32-C6-MINI-1-N4 (4 MB flash on the module is enough for hosted slave).
- Antenna keepout from the module drawing. No ground pour in the keepout. No traces under the antenna.
- SDIO nets as [pin-map.md](pin-map.md).
- `CHIP_PU` from P4 GPIO54, active high. Do not tie C6 `CHIP_PU` only to C6 3V3 unless you also drive GPIO54 the same way; firmware expects to reset the slave.
- Hosted slave image is software (`esp32-p4/components/tonerelay/slave_fw/`). Hardware just needs SDIO + reset.

## Debug UART

- USB-C D+/D− → USB-UART (CH343P is what the NANO uses; CP2102N is fine).
- UART 3V3 I/O to P4 GPIO37/38. If the bridge is 3V3, no shifter.
- **DTR and RTS** go to a 3-pin jumper or two 0 Ω defaults **DNP**:
  - DNP: serial open does not reset the P4 (required)
  - Populate: Arduino-style auto-download for factory
- `BOOT` and `RESET` buttons always present.

## Indicators and buttons

- Power LED on `V5` or 3V3 (hardware).
- Three firmware LEDs as reserved GPIOs, 1 kΩ, small 0603 LED.
- `BTN_FACTORY` to GND.

## Test points (all 1.0 mm or 1.27 mm)

`TP_GND`, `TP_V5`, `TP_3V3`, `TP_VBUS`, `TP_U0TX`, `TP_U0RX`, `TP_CHIP_PU`, `TP_C6_PU`, `TP_SDIO_CLK`.

No test point directly on USB HS DP/DM.

## Silkscreen

- `ToneRelay P4`
- USB-A: `HELIX HOST`
- USB-C: `CHARGE / DEBUG`
- JST: `1S Li-ion` and polarity
- `AUTO_DL` default OFF
- Do not print passwords, MAC addresses, or git hashes that look like keys

## ERC expectations

- Every power pin on P4 and C6 driven
- No HS USB net with a default 4.7 kΩ ERC pin type mismatch left unexplained
- VBUS_OUT is power output, not input
- USB-C VBUS is input
