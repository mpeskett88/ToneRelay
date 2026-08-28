# ToneRelay

ToneRelay is a browser editor for a Line 6 Helix Floor. A Raspberry Pi talks
to the Helix over USB and serves the editor on your LAN, so you do not need
HX Edit on a Mac or Windows PC.

Verified on Helix Floor firmware 3.80.

## Disclaimer

ToneRelay is an independent project. It is not affiliated with, authorized,
endorsed, or sponsored by Line 6 or Yamaha Guitar Group. "Line 6", "Helix",
"HX", and "HX Edit" are trademarks of their respective owners and are used
here only to identify the hardware ToneRelay talks to.

The software is provided "as is", without warranty of any kind. You assume
all risk. Back up your presets before you write to the device.

## Requirements

- Raspberry Pi 4 or 5 running 64-bit Raspberry Pi OS
- Internet access on the Pi (clone and first build)
- Helix Floor, connected to the Pi with USB
- The Helix must not be plugged into another computer at the same time

## Install

Replace `OWNER` with the GitHub account that hosts this repository.

1. Clone the repository:

```sh
git clone git@github.com:OWNER/ToneRelay.git
cd ToneRelay
```

2. Run the installer:

```sh
sudo ./scripts/install.sh
```

The first run compiles the USB daemon and the web GUI. That can take a long
time on a Pi. The script prefers HTTP port 80, then 8080, and asks you for a
port if both are taken. Pass `--port N` to choose a port yourself.

When it finishes, it prints URLs for the editor.

## Open the editor

Put your phone or computer on the same Wi-Fi as the Pi. Open the URL the
installer printed, then tap **Wi-Fi**.

If `http://HOSTNAME.local/` does not load, use the IP address the installer
printed. On iPhone, you can use Share → Add to Home Screen.

## Model names and the model picker

Names, ranges, and the model picker come from HX Edit data files. Those files
are Line 6's and are not included here.

The editor still talks to the Helix without them. Knobs may show numbers, and
you cannot open the model sheet until the catalog is present.

If you have an HX Edit installer (`.dmg` or `.exe`) on the Pi, point the
install script at it:

```sh
sudo HX_EDIT_INSTALLER=/path/to/HX_Edit.dmg ./scripts/install.sh
```

To add the catalog later:

```sh
./scripts/extract-hx-catalog.sh /path/to/HX_Edit.dmg
sudo systemctl restart hxbridge-usb.service
```

You can also copy an existing `~/.local/share/tonepush/hx-resources` folder
from a machine that already extracted HX Edit.

## Safety

- Use the editor only on a trusted LAN. There is no login. Traffic is HTTP.
- Do not port-forward the editor to the internet.
- Do not flash firmware with this project.
- The Helix accepts one USB host at a time. Stop the Pi services before you
  plug the Helix into a computer running HX Edit:

```sh
sudo systemctl stop hxbridge-http.service hxbridge-usb.service
```

## Update and uninstall

```sh
git pull
sudo ./scripts/install.sh
```

```sh
sudo ./scripts/install.sh --uninstall
```

Uninstall removes the services, udev rule, and Avahi advertisement. It leaves
the clone, Rust, and Node on the Pi.

## Use the network backend from another app

The Pi exposes the same JSON commands over a WebSocket (`ws://HOST/ws`). You
can drive that socket from your own editor and skip the ToneRelay GUI. See
[docs/integrators.md](docs/integrators.md).

## Acknowledgements

ToneRelay stands on work that other people published first. Thank you.

- [TonePush](https://github.com/crmne/tonepush) is the USB engine. The daemon
  uses its `hx-proto`, `hx-usb`, and `hx-catalog` crates for the live session,
  preset document, and optional HX Edit catalog. The catalog extract script
  is TonePush's as well.
- [openhx](https://github.com/allansomensi/openhx) was the first USB stack in
  this tree. It proved Helix Floor list and select on firmware 3.80 and is
  still here as a lab CLI.
- [helix_usb](https://github.com/kempline/helix_usb) is a Python reference
  for HX USB framing. Captures were checked against it so this project did
  not send packets from the wrong channel.

## License

MIT. See [LICENSE](LICENSE).

Lab notes, GATT details, and capture recipes are in
[docs/development.md](docs/development.md).
