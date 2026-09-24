#!/usr/bin/env bash
# Stay registered as a NoInputNoOutput pairing agent so an iPhone can pair
# without a PIN. bluetoothctl exits when its input closes, so this holds the
# pipe open.
set -euo pipefail

coproc BT { /usr/bin/bluetoothctl --agent NoInputNoOutput; }
printf 'default-agent\n' >&"${BT[1]}"
wait "${BT_PID}"
