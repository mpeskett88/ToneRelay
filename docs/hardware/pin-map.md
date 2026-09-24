# Pin map

Firmware-locked pins are a **contract**. Changing them requires a firmware board-id fork. Rev 1 must match the NANO / `sdkconfig.defaults` map so `hxbridge-p4` runs unmodified.

Sources: `esp32-p4/README.md`, `esp32-p4/sdkconfig.defaults`, Waveshare ESP32-P4-NANO schematic, Espressif P4 USB PHY notes.

## Locked: C6 SDIO (esp_hosted)

| P4 GPIO | Net | C6 function | Notes |
| --- | --- | ---: | --- |
| 14 | `SDIO_D0` | SDIO D0 | 4-bit SDIO |
| 15 | `SDIO_D1` | SDIO D1 | |
| 16 | `SDIO_D2` | SDIO D2 | |
| 17 | `SDIO_D3` | SDIO D3 | |
| 18 | `SDIO_CLK` | SDIO CLK | Keep short, far from USB HS |
| 19 | `SDIO_CMD` | SDIO CMD | |
| 54 | `C6_CHIP_PU` | C6 `CHIP_PU` | `CONFIG_ESP_HOSTED_SDIO_GPIO_RESET_SLAVE=54`, **active high** (`CONFIG_ESP_HOSTED_SDIO_RESET_ACTIVE_HIGH=y`) |

Series 22–33 Ω on CLK/CMD/D0–D3 at the **P4** end. Pull-ups on CMD/D0–D3 as in the NANO schematic (NANO uses 51 kΩ to 3V3 on those lines).

Optional NANO extras (C6 UART, C6 IO2/8/9/12/13) are **not** required for ToneRelay Wi-Fi. Leave them unconnected or test-padded. Do not steal GPIO14–19 or 54 for LEDs.

## Locked: console / flash UART

| P4 GPIO | Net | Direction (P4) | Notes |
| --- | --- | --- | --- |
| 37 | `U0TXD` | out | USB-UART RX |
| 38 | `U0RXD` | in | USB-UART TX |

This is UART0 on the NANO (CH343). `espflash` and the `wifi` / `wifi-forget` console use it.

## Locked: USB High-Speed (Helix)

Not GPIOs. Use the dedicated HS PHY:

| P4 pin (datasheet) | Net | USB-A |
| --- | --- | --- |
| HS `DP` (Espressif: pin 50) | `USB_HS_DP` | D+ |
| HS `DM` (Espressif: pin 49) | `USB_HS_DM` | D− |
| `VDD_USBPHY` | 2.97–3.63 V | Decouple 10 nF + 0.1 µF + 4.7 µF at the pin |

Confirm pin 49/50 against the **P4NRW32** datasheet for the package you buy. Names `DP`/`DM` are the requirement; numbers must match the PDF.

USB-A pin 1 = `VBUS_OUT` (switched 5 V), pins 2/3 = D−/D+, pin 4 = GND. Shield to GND with a parallel RC or direct GND per the connector vendor; bond the shell.

## Do not use for Helix

| P4 pins | Function | Rev 1 use |
| --- | --- | --- |
| GPIO24 (D−), GPIO25 (D+) | USB Serial/JTAG FS | Optional test pads only |
| GPIO26 (D−), GPIO27 (D+) | USB FS OTG | Leave unused |

Helix 512-byte bulk does not run on Full-Speed.

## Straps and reset

Follow Espressif’s P4 schematic checklist for `CHIP_PU`, boot straps, and flash. Provide:

- `RESET` button on `CHIP_PU` (active low to GND, pull-up as in the reference).
- `BOOT` button on the download-strap GPIO specified in the datasheet for this package (NANO has a BOOT button; copy that net from the NANO schematic, do not invent a strap).
- `AUTO_DL` jumper that is the **only** path from USB-UART DTR/RTS to `CHIP_PU` / BOOT. Default open.

## Reserved for later firmware (not locked)

Use these only if they are free on the chosen package after flash, PSRAM, and straps:

| Net | Suggested GPIO | Electrical |
| --- | --- | --- |
| `BTN_FACTORY` | 53 | Button to GND, 10 kΩ pull-up, 100 nF debounce optional |
| `LED_RADIO` | 45 | LED + resistor to GND, active high |
| `LED_USB` | 46 | same |
| `LED_BATT` | 47 | same or charger STAT |
| `VBUS_EN` | 48 | Load-switch ON when high; **hardware pull-up so VBUS is ON if firmware never toggles it** |
| `I2C_SDA` | 7 | Optional fuel gauge; NANO I2C map |
| `I2C_SCL` | 8 | same |

If GPIO7/8 are inconvenient on the package, skip the fuel gauge on rev 1 rather than moving SDIO.

## Power pins

Copy **verbatim** from the Espressif P4NRW32 reference schematic:

- All `VDD_HP`, `VDD_LP`, analog, flash, and PSRAM rails
- `VDD_USBPHY` as above
- Ground every GND pad
- Do not leave `VDD_USBPHY` floating (HS PHY is required)

C6-MINI-1: 3V3 and GND per module datasheet. Common ground with P4. Do not run C6 from a noisy USB VBUS.

## NANO header (sled only)

If someone designs the optional NANO sled instead of the product board, feed **5 V** and **GND** on the NANO external-power header (wiki item 9). Do not inject 5 V into USB-C VBUS and the header at the same time without diode-OR. Helix stays on the NANO USB-A. That sled does not need this SDIO pin map redrawn; it is already on the NANO.
