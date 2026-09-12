#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
. /home/admin/esp/esp-idf-v5.5.3/export.sh
if [[ -d "$ROOT/web/node_modules" ]]; then
  (cd "$ROOT/web" && npm run build)
fi
cd "$ROOT/esp32-p4"
exec cargo build --release "$@"
