# Mechanical and BOM

## Enclosure

Target a pedalboard box, not a DevKit.

| Item | Guidance |
| --- | --- |
| Outline | ≤ 100 mm × 70 mm electronics, or that plus a 18650 bay |
| Height | USB-A receptacle + 18650 (~20 mm) dominates |
| Material | Plastic preferred for the C6 antenna. Metal only with an antenna window |
| USB-A | Panel mount / PCB-edge, labelled Helix |
| USB-C | Opposite or adjacent edge, labelled charge/debug |
| Switch | Power slide, recessed so a cable cannot toggle it |
| Strain | USB-A through-hole tabs + enclosure lip |

A Hammond 1590B-class box is acceptable if the antenna keepout is under plastic. Do not put the C6 antenna against a steel 1590 lid.

## Battery

- Default: one 18650 in a key-protected holder, or a 1S pack with JST and a PCM.
- Do not hot-glue a pouch without a holder.
- Charge only from USB-C. No Helix 9 V tap.

## Connectors

| Ref | Part class | Notes |
| --- | --- | --- |
| J_HELIX | USB-A receptacle, through-hole | Host, VBUS out |
| J_DBG | USB-C receptacle | Charge + UART |
| J_BAT | JST-PH 2.0 2-pin | 1S, polarity silk |
| SW_PWR | SPDT slide | Breaks boost enable or 5 V |

## BOM guidance (rev 1)

Prefer LCSC basic parts. Exact MPN is the CAD agent’s choice if the class matches.

| Function | Class | Do not |
| --- | --- | --- |
| MCU | ESP32-P4NRW32, rev ≥ 3.0, 32 MB PSRAM | ESP32-S3 as host |
| Flash | 16 MB NOR, 3V3, Espressif-supported | 8 MB only |
| Radio | ESP32-C6-MINI-1-N4 | Bare C6 die; C6-only as USB host |
| USB-UART | CH343P, CH340N, or CP2102N, 3V3 I/O | Auto-reset hard-wired |
| HS ESD | Extra C ≤ 1 pF | FS USB ESD arrays |
| VBUS switch | Current-limit load switch, ≥ 1 A limit | Direct 5 V to VBUS with no limit |
| Boost | 5 V, 2 A class | Mini 500 mA boost |
| Charger | 1S, ~1 A, power-path if possible | Bare TP4056 with no path, no fuse |
| 5V fuse | Polyfuse on USB-C VBUS | Nothing |

Decoupling capacitors: 0402/0201 as Espressif shows near the P4. Do not “optimize away” `VDD_USBPHY` caps.

## Assembly

- JLCPCB SMT + customer-solder USB-A and 18650 holder is fine.
- C6 module: reflow per Espressif module profile; antenna keepout after paste.
- P4NRW32 is a fine-pitch IC. If that is too hard, stop and ask about a P4 **module** that still exposes HS DP/DM and GPIOs 14–19, 37, 38, 54.

## Firmware-facing labels

Silk `HELIX HOST` on USB-A so nobody flashes firmware through the Helix port.

## Cost class

Rev 1 is a lab gadget. A few tens of USD in parts plus PCB is expected. Do not add a TFT to look like the NANO.
