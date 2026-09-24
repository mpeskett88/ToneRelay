# Layout

USB High-Speed and SDIO are why this is a 4-layer board. If those two buses are wrong, Wi-Fi and Helix both fail in ways that look like firmware bugs.

## Stackup (default)

JLCPCB 4-layer 1.6 mm, JLC04161H-7628 or the current “impedance 90 Ω differential” stack they publish.

| Layer | Use |
| --- | --- |
| L1 | USB HS pair, SDIO, short GPIO, C6 antenna keepout |
| L2 | Solid GND |
| L3 | 5 V / 3V3 pours, no split under USB or SDIO |
| L4 | Low-speed, LEDs, buttons, remaining pour GND |

Do not split L2 under the USB pair or SDIO CLK.

USB HS target: **90 Ω differential** (±10%). Use the fabricator’s calculator for that stackup. Typical ~0.2 mm trace / 0.15 mm gap — confirm, do not copy blindly.

SDIO: single-ended ~50 Ω if the stackup allows; matching **length** matters more than exact Z0 on a few centimetres.

## Floorplan

Place in this order:

1. USB-A on one edge, P4 HS PHY as close as the package allows (target **< 30 mm** pair length).
2. P4NRW32 and flash, decoupling on L1/L4 with vias to L2 at each cap GND.
3. C6-MINI-1 on the **opposite** edge or a corner, antenna off the board edge.
4. SDIO as a short parallel bus between P4 and C6 (target **< 50 mm**).
5. Boost/charger away from SDIO CLK and USB pair.
6. Battery connector away from USB-A ESD.

Helix cables are bulky. Keep USB-A mechanically on the enclosure wall, not in the middle of the PCB.

## USB HS pair

- Route `USB_HS_DP` / `USB_HS_DM` as a tight differential pair on L1 over solid L2.
- Length match **≤ 0.15 mm**.
- No vias if possible. If a via is required, via both lines together and stitch GND vias beside them.
- No 90° corners; 45° or arcs.
- No stubs. Series 0 Ω at the PHY, ESD at the connector, nothing else on the net.
- ESD GND pad with multiple vias to L2.
- Connector shield: several vias to GND.

Espressif: HS ESD extra capacitance **≤ 1 pF**. A “USB FS” TVS will fail HS.

## SDIO

- CLK, CMD, D0–D3 as a group. CLK length is the reference; others within **~5 mm**.
- Series 22–33 Ω at P4 pads.
- CLK far from USB DP/DM (do not run them parallel).
- Far from the C6 antenna keepout.
- GPIO54 (`C6_CHIP_PU`) is slow; route anywhere sane, pull as NANO does.

Third-party NANO carriers have reported SDIO plus RMII Ethernet coupling. This product **has no Ethernet**. Do not add it.

## RF keepout

Follow the ESP32-C6-MINI-1 module hardware guidelines:

- Copper keepout under and in front of the antenna
- No metal enclosure over the antenna (plastic window or antenna off the PCB edge)
- 2.4 GHz only; no second antenna for 5 GHz

## Power integrity

- Each P4 power pin: 0.1 µF within 2 mm, plus bulk as Espressif shows.
- `VDD_USBPHY`: 10 nF + 0.1 µF + 4.7 µF at the pin, GND vias next to the caps.
- USB DMA in firmware uses **internal RAM**. A 3V3 dip still wedges the DWC. Treat 3V3 like an analog rail during bursts.
- Boost inductor away from SDIO CLK. Rotate the inductor to minimise coupling into GPIO18.

## Mechanics on the PCB

- Through-hole USB-A, solder all tabs.
- USB-C through-hole or a mid-mount with through-hole shells.
- Mounting holes 3.2 mm, plated, tied to GND, ≥ 4 holes, 5 mm keepout from copper to hole if the screw is conductive and the enclosure is metal — or isolate if the chassis is ground.

## DRC

- Min 0.15 mm clearance unless USB pair needs tighter (then set a net-class exception).
- Via 0.3 mm / 0.15 mm drill acceptable.
- Silk not on pads.
- Courtyards: C6 keepout is a courtyard. DRC must fail if a pour enters it.

## What “looks like a firmware USB bug” but is layout

- Extra pF on DP/DM → enumeration at FS or flaky 512-byte bulk
- GND split under the pair → same
- SDIO CLK ringing → C6 0.0.0, Wi-Fi down, hosted OTA loops
- GPIO54 floating at power-up → C6 never comes out of reset
- 3V3 collapse on Helix IN burst → parked URBs, watchdog, Helix 9 V pull
