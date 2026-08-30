#!/bin/bash
# Copy HX Edit catalog files onto this machine. Those files are Line 6's.
# Do not commit them.
#
# On a Raspberry Pi, pass the Windows installer (.exe). The macOS .dmg
# only extracts on macOS (hdiutil).
#   ./scripts/extract-hx-catalog.sh /path/to/HX_Edit.exe
#   ./scripts/extract-hx-catalog.sh /path/to/HX_Edit_3.82.dmg
#
# Then copy ~/.local/share/tonepush/hx-resources to the Pi if you extracted
# on another computer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTRACT="$ROOT/vendor/tonepush/tools/hxresources/extract.sh"
if [[ ! -x "$EXTRACT" ]]; then
  printf 'error: TonePush extract script missing at %s\n' "$EXTRACT" >&2
  exit 1
fi
if [[ $# -eq 0 ]]; then
  exec "$EXTRACT"
fi
exec "$EXTRACT" "$@"
