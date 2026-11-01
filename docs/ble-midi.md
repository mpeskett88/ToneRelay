# BLE MIDI input (ESP32-P4)

An optional input for the ESP32-P4 firmware: the box shows up as a Bluetooth LE MIDI device, the way a WIDI Jack does, and forwards what it
receives to the pedal's USB MIDI interface. A phone, tablet or DAW (OnSong, AUM, Audio MIDI Setup) can then send program changes, MIDI clock
and notes to a Helix or HX pedal through the box, with no MIDI cable. The pedal's own MIDI Thru passes it on to other pedals.

It is off unless you build it in, and nothing else in the firmware depends on it.

## Building it in

```bash
cd esp32-p4
ESP_IDF_SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.midi.defaults" cargo build
```

`sdkconfig.midi.defaults` sets `CONFIG_TONERELAY_BLE_MIDI=y` (the whole feature) and `CONFIG_BT_NIMBLE_NVS_PERSIST=y` (keeps a phone's pairing across
restarts). `CONFIG_TONERELAY_BLE_MIDI_ENCRYPT` (default on) makes the MIDI characteristic readable and writable only over an encrypted link.
After a change to a `.c` file, `touch sdkconfig.defaults` so the component is rebuilt.

When the box starts it logs `BLE MIDI starting` and `advertising MIDI as <name>`. The name is the profile's mDNS instance name, for example
`Helrig Box e7fb0b`.

## Connecting

Use Apple's own list of Bluetooth MIDI devices: Audio MIDI Setup on a Mac (Window, Show MIDI Studio, Bluetooth), or any iPad app that shows it, such
as AUM. The box is then a MIDI destination for every app on that device. An app's own Bluetooth connect button may not get the box connected: OnSong's
did not on the bench, though OnSong showed the box connected as soon as the list had connected it. An app can make the same connection with
`MIDIBluetoothDriverActivateAllConnections` (iOS 16 and later), as `MIDIBluetoothConnection.h` describes.

Apple's MIDI stack sends a MIDI-CI Discovery message when a device connects and holds data back, or gives up, until it is answered. The box answers
it with a reply that supports no MIDI-CI features, and does not pass MIDI-CI messages on to the pedal.

## What it does

| Part | File | |
|---|---|---|
| BLE MIDI service `03B80E5A-EDE8-4B33-A751-6CE34EC4C700`, one characteristic `7772E5DB-3868-4112-A1A9-F2669D106BF3` (read, write, write without response, notify) | `midi_ble.c` | Advertising, pairing and bonding ("Just Works"), connection interval 11.25 to 15 ms. It keeps advertising while one phone is connected, so a second one could connect (not tried). |
| BLE MIDI packet parser, MIDI-CI Discovery reply, MIDI to USB-MIDI packet encoder | `blemidi.c` | No ESP-IDF code: `test/blemidi_test.c` runs on a computer (`cc -I.. -o blemidi_test blemidi_test.c ../blemidi.c`). |
| USB MIDI to the pedal | `usb_midi.c` | A second USB client. It finds the MIDI streaming interface (class 1, subclass 3) in the active configuration of a Line 6 device and claims it, so it works with or without a Helix session open. It reads and drops what the pedal sends back. |

Messages pass through unchanged, including MIDI clock and SysEx, also when a SysEx is split over several packets (the host test covers that; the bench only sent clock, program changes and notes). Up to 512 USB-MIDI packets wait for the
pedal; when it does not keep up, new messages are dropped.

## Limits

* **Anyone in Bluetooth range can pair.** "Just Works" pairing stops eavesdropping on a pairing that already exists, not a stranger who pairs first.
  There is no pairing window yet. Do not use it where a stranger sending MIDI to the pedal matters.
* One direction only: the pedal's MIDI output is read and dropped, not sent to the phone.
* Cable number 0 only.
* Tried with an HX Stomp (USB MIDI is interface 4, endpoints `0x02` and `0x82`). Other Helix and HX pedals should have the same interface, but have not been
  tried.
* The Wi-Fi and Bluetooth radios are the C6's: Bluetooth MIDI, a Wi-Fi network and a Helix session ran together on the bench without dropping messages,
  but there has been no long run.

## Tested

On a Waveshare ESP32-P4-NANO with an HX Stomp, an iPad (OnSong, AUM) and a Mac (Audio MIDI Setup): connecting and pairing, MIDI-CI discovery, MIDI clock,
program changes and notes arriving, a preset change on the pedal from OnSong, the pedal's MIDI Thru reaching other pedals, and a Helix session open at the same time.
