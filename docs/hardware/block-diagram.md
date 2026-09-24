# Block diagrams

These diagrams are the cover-sheet drawing. Copy the boxes onto the KiCad schematic. Do not add Ethernet, MIPI, codec, or a USB hub.

## System

```mermaid
flowchart LR
  phone["Phone\nSafari or BLE"]
  helix["Helix Floor\nUSB device HS\nVID 0E41 PID 4248\nself-powered 9V"]

  subgraph gadget["ToneRelay P4 board"]
    usbc["USB-C\ncharge + UART"]
    uart["USB-UART\nDTR/RTS isolated"]
    p4["ESP32-P4NRW32\nUSB HS host\nPSRAM + 16MB flash"]
    c6["ESP32-C6-MINI-1\nWi-Fi 6 2.4 GHz + BLE"]
    usba["USB-A host\nVBUS 5V switched"]
    bat["1S Li-ion\ncharger + boost 5V"]
  end

  phone -->|"Wi-Fi HTTP / mDNS\nor BLE GATT"| c6
  c6 -->|"SDIO 4-bit\nGPIO14-19, RST 54"| p4
  usbc --> uart
  uart -->|"UART0 GPIO37/38"| p4
  usbc --> bat
  bat -->|"5V"| p4
  bat -->|"5V VBUS"| usba
  p4 -->|"HS DP/DM"| usba
  usba --> helix
```

USB roles: the phone is not a USB host for the Helix. The P4 is the only USB host.

## Power tree

```mermaid
flowchart TB
  usbc_vbus["USB-C VBUS 5V"]
  cell["1S cell JST\nprotected pack"]
  charger["Li-ion charger\nplus UV/OC as IC allows"]
  boost["Boost 5V 2A class"]
  sw["Power switch"]
  v5["5V rail"]
  vbus_sw["VBUS load switch\ncurrent limit"]
  usba["USB-A VBUS"]
  dcdc["P4 module/chip 3V3\nand other Espressif rails"]
  vusbphy["VDD_USBPHY 3V3\n10nF + 0.1uF + 4.7uF"]
  c6v["C6 module 3V3"]

  usbc_vbus --> charger
  cell --> charger
  charger --> cell
  cell --> boost
  boost --> sw
  sw --> v5
  v5 --> vbus_sw
  vbus_sw --> usba
  v5 --> dcdc
  dcdc --> vusbphy
  dcdc --> c6v
```

If the P4NRW32 reference schematic wants 5 V into an onboard DCDC, feed that 5 V from `v5`, not from USB-A VBUS. USB-A VBUS is an **output**.

## USB and debug (do not mix)

```mermaid
flowchart LR
  subgraph hel["Helix path — HS host"]
    phy["P4 HS PHY\nDP pin 50 / DM pin 49"]
    esd["ESD less than 1 pF"]
    typea["USB-A"]
    phy --> esd --> typea
  end

  subgraph dbg["Debug path — not Helix"]
    typec["USB-C"]
    br["USB-UART"]
    jmp["AUTO_DL jumper\ndefault open"]
    uart["UART0 37/38"]
    en["CHIP_PU / BOOT"]
    typec --> br --> uart
    br -.->|"only if jumper on"| jmp --> en
  end
```

P4 also has Full-Speed USB Serial/JTAG on GPIO24 (D−) and GPIO25 (D+). Optional test pads only on rev 1. Do not wire those GPIOs to the USB-A Helix connector.

## Radio

```mermaid
flowchart LR
  p4["P4 SDIO host"]
  p4 -->|"CLK 18"| clk["C6 SDIO CLK"]
  p4 -->|"CMD 19"| cmd["C6 SDIO CMD"]
  p4 -->|"D0-D3 14-17"| dat["C6 SDIO data"]
  p4 -->|"GPIO54 active high"| rst["C6 CHIP_PU"]
  c6["C6-MINI-1"]
  ant["On-module antenna\nkeepout"]
  clk --> c6
  cmd --> c6
  dat --> c6
  rst --> c6
  c6 --> ant
```

Copy C6 pad numbers from the [NANO schematic](https://files.waveshare.com/wiki/ESP32-P4-NANO/ESP32-P4-NANO-schematic.pdf) and the C6-MINI-1 datasheet. Do not guess C6 ball IDs.

## Data path (firmware, for context)

```mermaid
flowchart LR
  spa["SPA in flash\nHTTP"]
  http["httpd + WS"]
  rust["hxbridge-p4 Rust\nhx-usb session"]
  cusb["usb.c host"]
  helix["Helix IF0 bulk"]

  spa --> http --> rust --> cusb --> helix
```

The PCB does not implement this. It only has to keep 3V3, SDIO, and HS USB alive while it runs.
