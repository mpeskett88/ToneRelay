# External references

Open these; do not scrape random blogs as electrical truth.

## This repository

- Firmware: `esp32-p4/README.md`
- USB host: `esp32-p4/components/tonerelay/usb.c`
- Hosted C6: `esp32-p4/sdkconfig.defaults`, `esp32-p4/components/tonerelay/c6_ota.c`
- Partitions: `esp32-p4/partitions.csv`
- Helix protocol: `docs/tonepush-floor.md`, `vendor/tonepush/`

## Espressif

- [ESP32-P4 datasheet (PDF)](https://documentation.espressif.com/esp32-p4_datasheet_en.pdf)
- [ESP32-P4 hardware design guidelines (PDF)](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32p4/esp-hardware-design-guidelines-en-master-esp32p4.pdf)
- [ESP32-P4 schematic checklist](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32p4/schematic-checklist-esp32p4.html)
- USB PHY overview (FS vs HS pins): [esp-iot-solution usb_phy.rst](https://github.com/espressif/esp-iot-solution/blob/master/docs/en/usb/usb_overview/usb_phy.rst)
- ESP32-C6-MINI-1 module datasheet / HW guide (antenna keepout) from Espressif’s module pages
- `esp_hosted` SDIO slave for ESP32-C6 (component used at ~2.12.13)

## Waveshare (bring-up board only)

- [ESP32-P4-NANO wiki](https://docs.waveshare.com/ESP32-P4-NANO)
- [ESP32-P4-NANO schematic PDF](https://files.waveshare.com/wiki/ESP32-P4-NANO/ESP32-P4-NANO-schematic.pdf)

Copy from NANO: USB-A HS, C6 SDIO, UART0 GPIOs. Do not copy Ethernet, MIPI, codec, microSD, PoE.

## Line 6 (USB device)

- Helix Floor USB 2.0 High-Speed composite device, vendor interface 0 for HX Edit-class traffic
- Lab: VID `0x0E41`, PID `0x4248`, firmware 3.80
- Helix 9 V is independent. USB VBUS is still required for enumeration.
