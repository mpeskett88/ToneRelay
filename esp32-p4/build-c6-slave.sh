#!/usr/bin/env bash
# Build ESP-Hosted slave firmware for the onboard ESP32-C6 (SDIO).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
IDF="${IDF_PATH:-/home/admin/esp/esp-idf-v5.5.3}"
OUT="$ROOT/components/tonerelay/slave_fw/network_adapter.bin"

HOSTED=""
if [[ -d "$ROOT/managed_components/espressif__esp_hosted/slave" ]]; then
  HOSTED="$ROOT/managed_components/espressif__esp_hosted"
else
  HOSTED="$(find "$ROOT/target" -type d -path '*/managed_components/espressif__esp_hosted' 2>/dev/null | head -1 || true)"
fi
if [[ -z "$HOSTED" || ! -d "$HOSTED/slave" ]]; then
  echo "esp_hosted slave example not found; run a P4 cargo build first" >&2
  exit 1
fi

unset IDF_PYTHON_ENV_PATH || true
# shellcheck disable=SC1091
. "$IDF/export.sh"

WORKDIR="$ROOT/.c6-hosted"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
cp -a "$HOSTED/." "$WORKDIR/"
cd "$WORKDIR/slave"
idf.py set-target esp32c6
idf.py build
mkdir -p "$(dirname "$OUT")"
cp -f build/network_adapter.bin "$OUT"
ls -l "$OUT"
