#!/usr/bin/env bash
# Install ToneRelay on a Raspberry Pi: USB daemon + HTTP GUI.
# Run as: sudo ./scripts/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF_PATH=/etc/hxbridge.conf
UDEV_DEST=/etc/udev/rules.d/99-line6-helix.rules
USB_UNIT=/etc/systemd/system/hxbridge-usb.service
HTTP_UNIT=/etc/systemd/system/hxbridge-http.service
AVAHI_DEST=/etc/avahi/services/hxbridge.service
MSRV=1.87.0

usage() {
  cat <<'EOF'
Install ToneRelay (USB daemon + HTTP editor) on this Raspberry Pi.

Usage:
  sudo ./scripts/install.sh
  sudo ./scripts/install.sh --port 8080
  sudo ./scripts/install.sh --uninstall

Options:
  --port N       HTTP listen port (default: 80, then 8080 if 80 is taken)
  --uninstall    Stop services and remove units, udev, Avahi, and /etc/hxbridge.conf
  -h, --help     Show this help

Environment:
  HXBRIDGE_HTTP_PORT   Same as --port, if --port is not passed
  HX_EDIT_INSTALLER    Path to an HX Edit installer for model names.
                       On a Raspberry Pi use the Windows .exe; .dmg needs macOS.
EOF
}

log() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; }

UNINSTALL=0
PORT_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --port)
      if [[ $# -lt 2 ]]; then
        err "--port needs a number"
        exit 2
      fi
      PORT_OVERRIDE="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      err "unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  err "run as root: sudo $0"
  exit 1
fi

INSTALL_USER="${SUDO_USER:-}"
if [[ -z "$INSTALL_USER" || "$INSTALL_USER" == "root" ]]; then
  err "do not log in as root; run sudo from your Pi user"
  exit 1
fi
INSTALL_HOME="$(getent passwd "$INSTALL_USER" | cut -d: -f6)"
if [[ -z "$INSTALL_HOME" || ! -d "$INSTALL_HOME" ]]; then
  err "could not find home directory for $INSTALL_USER"
  exit 1
fi

as_user() {
  sudo -u "$INSTALL_USER" -H bash -lc "[[ -f \"$INSTALL_HOME/.cargo/env\" ]] && . \"$INSTALL_HOME/.cargo/env\"; $*"
}

version_ge() {
  [[ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && [[ "$1" -ge 1 ]] && [[ "$1" -le 65535 ]]
}

load_conf() {
  if [[ -f "$CONF_PATH" ]]; then
    # shellcheck disable=SC1090
    . "$CONF_PATH"
  fi
}

our_http_active() {
  systemctl is-active --quiet hxbridge-http.service 2>/dev/null
}

port_in_use() {
  local port="$1"
  ss -lntH "sport = :${port}" 2>/dev/null | grep -q .
}

port_busy_for_us() {
  local port="$1"
  if ! port_in_use "$port"; then
    return 1
  fi
  if our_http_active && [[ "${HXBRIDGE_HTTP_PORT:-}" == "$port" ]]; then
    return 1
  fi
  return 0
}

write_conf() {
  cat >"$CONF_PATH" <<EOF
HXBRIDGE_ROOT=$ROOT
HXBRIDGE_USER=$INSTALL_USER
HXBRIDGE_HTTP_PORT=$HXBRIDGE_HTTP_PORT
EOF
  chmod 644 "$CONF_PATH"
}

render_file() {
  local src="$1"
  local dest="$2"
  local caps=""
  if [[ "$HXBRIDGE_HTTP_PORT" -lt 1024 ]]; then
    caps=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'
  fi
  local line
  : >"$dest"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *"__HXBRIDGE_HTTP_CAPS__"* ]]; then
      if [[ -n "$caps" ]]; then
        printf '%s\n' "$caps" >>"$dest"
      fi
      continue
    fi
    line="${line//__HXBRIDGE_ROOT__/$ROOT}"
    line="${line//__HXBRIDGE_USER__/$INSTALL_USER}"
    line="${line//__HXBRIDGE_HTTP_PORT__/$HXBRIDGE_HTTP_PORT}"
    printf '%s\n' "$line" >>"$dest"
  done <"$src"
}

editor_url() {
  local host="$1"
  if [[ "$HXBRIDGE_HTTP_PORT" -eq 80 ]]; then
    printf 'http://%s/\n' "$host"
  else
    printf 'http://%s:%s/\n' "$host" "$HXBRIDGE_HTTP_PORT"
  fi
}

catalog_populated() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  [[ -f "$dir/Helix.sym" || -f "$dir/HX_ModelCatalog.json" || -f "$dir/.models" || -f "$dir/HelixControls.json" ]]
}

find_installer() {
  if [[ -n "${HX_EDIT_INSTALLER:-}" && -f "$HX_EDIT_INSTALLER" ]]; then
    printf '%s\n' "$HX_EDIT_INSTALLER"
    return 0
  fi
  local f exes=() dmgs=()
  shopt -s nullglob
  for f in \
    "$ROOT"/HX_Edit*.exe "$ROOT"/HXEdit*.exe "$PWD"/HX_Edit*.exe "$PWD"/HXEdit*.exe \
    "$ROOT"/HX_Edit*.dmg "$ROOT"/HXEdit*.dmg "$PWD"/HX_Edit*.dmg "$PWD"/HXEdit*.dmg; do
    [[ -f "$f" ]] || continue
    case "$f" in
      *.exe | *.EXE) exes+=("$f") ;;
      *.dmg | *.DMG) dmgs+=("$f") ;;
    esac
  done
  shopt -u nullglob
  # The Windows .exe extracts with 7-Zip on Linux. The .dmg needs macOS.
  if [[ ${#exes[@]} -gt 0 ]]; then
    printf '%s\n' "${exes[0]}"
    return 0
  fi
  if [[ ${#dmgs[@]} -gt 0 ]]; then
    printf '%s\n' "${dmgs[0]}"
    return 0
  fi
  return 1
}

uninstall() {
  log "Stopping ToneRelay services."
  systemctl stop hxbridge-http.service 2>/dev/null || true
  systemctl stop hxbridge-usb.service 2>/dev/null || true
  systemctl disable hxbridge-http.service 2>/dev/null || true
  systemctl disable hxbridge-usb.service 2>/dev/null || true
  rm -f "$USB_UNIT" "$HTTP_UNIT" "$UDEV_DEST" "$AVAHI_DEST" "$CONF_PATH"
  udevadm control --reload-rules 2>/dev/null || true
  if command -v systemctl >/dev/null; then
    systemctl daemon-reload
  fi
  log "Removed systemd units, udev rule, Avahi service, and $CONF_PATH."
  log "The clone, Rust toolchain, and Node install are unchanged."
}

choose_port() {
  load_conf
  if [[ -n "$PORT_OVERRIDE" ]]; then
    HXBRIDGE_HTTP_PORT="$PORT_OVERRIDE"
  elif [[ -n "${HXBRIDGE_HTTP_PORT_ENV:-}" ]]; then
    HXBRIDGE_HTTP_PORT="$HXBRIDGE_HTTP_PORT_ENV"
  elif [[ -n "${HXBRIDGE_HTTP_PORT:-}" ]]; then
    :
  else
    HXBRIDGE_HTTP_PORT=""
  fi

  if [[ -n "$HXBRIDGE_HTTP_PORT" ]]; then
    if ! valid_port "$HXBRIDGE_HTTP_PORT"; then
      err "port must be an integer from 1 to 65535 (got $HXBRIDGE_HTTP_PORT)"
      exit 1
    fi
    if port_busy_for_us "$HXBRIDGE_HTTP_PORT"; then
      err "port $HXBRIDGE_HTTP_PORT is already in use"
      ss -lntH "sport = :${HXBRIDGE_HTTP_PORT}" || true
      exit 1
    fi
    return 0
  fi

  if ! port_busy_for_us 80; then
    HXBRIDGE_HTTP_PORT=80
    return 0
  fi
  log "Port 80 is in use; trying 8080."
  if ! port_busy_for_us 8080; then
    HXBRIDGE_HTTP_PORT=8080
    return 0
  fi
  if [[ -t 0 ]]; then
    local guessed=""
    read -r -p "Ports 80 and 8080 are in use. HTTP port: " guessed
    if ! valid_port "$guessed"; then
      err "port must be an integer from 1 to 65535"
      exit 1
    fi
    if port_busy_for_us "$guessed"; then
      err "port $guessed is already in use"
      exit 1
    fi
    HXBRIDGE_HTTP_PORT="$guessed"
    return 0
  fi
  err "ports 80 and 8080 are in use; pass --port N"
  exit 1
}

install_apt() {
  local pkgs=(
    build-essential
    ca-certificates
    curl
    git
    pkg-config
    libusb-1.0-0-dev
    libudev-dev
    python3
    python3-aiohttp
    usbutils
    avahi-daemon
    libnss-mdns
    xz-utils
  )
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends "${pkgs[@]}"
}

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -v | sed 's/^v//' | cut -d. -f1
}

# Official Node tarball includes npm. Debian's npm package pulls in hundreds of
# node-* modules (webpack, babel, mesa, x11) that this project does not use.
install_node_official() {
  local arch tmp line sha tarball extracted
  case "$(uname -m)" in
    aarch64 | arm64) arch=linux-arm64 ;;
    x86_64) arch=linux-x64 ;;
    armv7l) arch=linux-armv7l ;;
    *) return 1 ;;
  esac
  tmp="$(mktemp -d)"
  if ! curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"; then
    rm -rf "$tmp"
    return 1
  fi
  line="$(awk -v arch="$arch" '
    $2 ~ ("^node-v22\\.[0-9.]+-" arch "\\.tar\\.xz$") { print; exit }
  ' "$tmp/SHASUMS256.txt")"
  if [[ -z "$line" ]]; then
    rm -rf "$tmp"
    return 1
  fi
  sha="${line%% *}"
  tarball="${line##* }"
  tarball="${tarball#./}"
  log "Installing Node.js from nodejs.org ($tarball)."
  if ! curl -fL "https://nodejs.org/dist/latest-v22.x/$tarball" -o "$tmp/$tarball"; then
    rm -rf "$tmp"
    return 1
  fi
  if ! (cd "$tmp" && printf '%s  %s\n' "$sha" "$tarball" | sha256sum -c --status); then
    err "Node.js tarball checksum mismatch"
    rm -rf "$tmp"
    return 1
  fi
  tar -xJf "$tmp/$tarball" -C "$tmp"
  extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -name 'node-v22*' -print -quit)"
  if [[ -z "$extracted" || ! -x "$extracted/bin/node" ]]; then
    rm -rf "$tmp"
    return 1
  fi
  rm -rf /usr/local/lib/nodejs
  mkdir -p /usr/local/lib
  mv "$extracted" /usr/local/lib/nodejs
  ln -sfn /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sfn /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
  ln -sfn /usr/local/lib/nodejs/bin/npx /usr/local/bin/npx
  rm -rf "$tmp"
  hash -r
  return 0
}

install_node() {
  local major
  major="$(node_major || true)"
  if [[ -n "$major" && "$major" -ge 20 ]]; then
    log "Using Node.js $(node -v)."
    return 0
  fi
  if install_node_official && [[ "$(node_major || true)" -ge 20 ]]; then
    log "Using Node.js $(node -v)."
    return 0
  fi
  log "Official Node.js download failed; installing Debian nodejs and npm."
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends nodejs npm
  if ! command -v node >/dev/null 2>&1; then
    err "Node.js is not installed"
    exit 1
  fi
  major="$(node_major || true)"
  if [[ -z "$major" || "$major" -lt 20 ]]; then
    err "Node.js 20 or newer is required (found $(node -v 2>/dev/null || echo none))"
    exit 1
  fi
  log "Using Node.js $(node -v)."
}

install_rust() {
  local ver=""
  if as_user "command -v rustc >/dev/null"; then
    ver="$(as_user "rustc --version" | awk '{print $2}')"
  fi
  if [[ -n "$ver" ]] && version_ge "$ver" "$MSRV"; then
    log "Using rustc $ver."
    return 0
  fi
  if ! as_user "command -v rustup >/dev/null"; then
    log "Installing Rust for $INSTALL_USER (rustup). Need $MSRV or newer (found ${ver:-none})."
    as_user "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"
  else
    log "Updating Rust (need $MSRV or newer; found ${ver:-none})."
    as_user "rustup update stable"
  fi
  ver="$(as_user "rustc --version" | awk '{print $2}')"
  if [[ -z "$ver" ]] || ! version_ge "$ver" "$MSRV"; then
    err "rustc $MSRV or newer is required (found ${ver:-none})"
    exit 1
  fi
  log "Using rustc $ver."
}

ensure_submodule() {
  if [[ -f "$ROOT/vendor/tonepush/crates/hx-usb/Cargo.toml" ]]; then
    return 0
  fi
  log "Initializing vendor/tonepush submodule."
  as_user "cd $(printf %q "$ROOT") && git submodule update --init --recursive"
  if [[ -f "$ROOT/vendor/tonepush/crates/hx-usb/Cargo.toml" ]]; then
    return 0
  fi
  err "vendor/tonepush crates are missing (hx-proto, hx-usb, hx-catalog). Clone with --recurse-submodules."
  exit 1
}

build_all() {
  log "Building hxbridge-usb (release). This can take a while on a Pi."
  as_user "cd $(printf %q "$ROOT") && cargo build -p hxbridge-usb --release"
  if [[ ! -x "$ROOT/target/release/hxbridge-usb" ]]; then
    err "build did not produce target/release/hxbridge-usb"
    exit 1
  fi
  log "Building the web GUI."
  as_user "cd $(printf %q "$ROOT/web") && npm ci && npm run build"
  if [[ ! -f "$ROOT/hxbridge/static/index.html" ]]; then
    err "GUI build did not write hxbridge/static/index.html"
    exit 1
  fi
}

install_catalog() {
  local dest="$INSTALL_HOME/.local/share/tonepush/hx-resources"
  log "HX Edit catalog files (model names, ranges, the model picker) are Line 6's."
  log "They are not redistributed. Without them the editor still talks to the Helix,"
  log "but the model picker is unavailable and some knobs show numbers instead of names."

  if catalog_populated "$dest"; then
    log "Catalog already present at $dest."
    return 0
  fi
  if catalog_populated "$ROOT/resources"; then
    log "Copying catalog from $ROOT/resources."
    as_user "mkdir -p $(printf %q "$dest") && cp -a $(printf %q "$ROOT/resources")/. $(printf %q "$dest")/"
    CATALOG_UPDATED=1
    return 0
  fi

  local installer=""
  if installer="$(find_installer)"; then
    case "$installer" in
      *.dmg | *.DMG)
        if ! command -v hdiutil >/dev/null 2>&1; then
          log "HX Edit .dmg files can only be read on macOS. On this Pi, use the Windows .exe."
          log "Then: ./scripts/extract-hx-catalog.sh /path/to/HX_Edit.exe"
          log "  and: sudo systemctl restart hxbridge-usb.service"
          return 0
        fi
        ;;
    esac
    log "Extracting catalog from $installer."
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y --no-install-recommends p7zip-full
    if [[ ! -f "$ROOT/vendor/tonepush/tools/hxresources/extract.sh" ]]; then
      log "TonePush extract script is missing; continuing without a catalog."
      return 0
    fi
    if ! as_user "cd $(printf %q "$ROOT") && ./scripts/extract-hx-catalog.sh $(printf %q "$installer")"; then
      log "Catalog extract failed. The editor still runs without model names."
      log "On a Raspberry Pi, pass the Windows HX Edit .exe, not the macOS .dmg."
      return 0
    fi
    if catalog_populated "$dest"; then
      log "Catalog installed at $dest."
      CATALOG_UPDATED=1
      return 0
    fi
    log "Extract finished but $dest does not look like an HX Edit catalog."
    return 0
  fi

  log "No catalog found. The editor still runs. To add names later:"
  log "  copy HX Edit resources into $dest"
  log "  or run: ./scripts/extract-hx-catalog.sh /path/to/HX_Edit.exe"
  log "  then: sudo systemctl restart hxbridge-usb.service"
}

install_udev() {
  getent group plugdev >/dev/null || groupadd --system plugdev
  usermod -aG plugdev "$INSTALL_USER"
  install -m 644 "$SCRIPT_DIR/99-line6-helix.rules" "$UDEV_DEST"
  udevadm control --reload-rules
  udevadm trigger --subsystem-match=usb --attr-match=idVendor=0e41 2>/dev/null || true
  log "Installed udev rule. Unplug and replug the Helix if it is already connected."
}

install_units() {
  render_file "$SCRIPT_DIR/hxbridge-usb.service" "$USB_UNIT"
  render_file "$SCRIPT_DIR/hxbridge-http.service" "$HTTP_UNIT"
  if [[ -d /etc/avahi/services ]]; then
    render_file "$SCRIPT_DIR/hxbridge.avahi.service" "$AVAHI_DEST"
  else
    log "Avahi is not installed; skip mDNS advertisement. Use the IP address."
  fi
  systemctl daemon-reload
  if systemctl list-unit-files avahi-daemon.service >/dev/null 2>&1; then
    systemctl enable --now avahi-daemon.service 2>/dev/null || true
  fi
  systemctl enable --now hxbridge-usb.service
  systemctl enable --now hxbridge-http.service
  if [[ "${CATALOG_UPDATED:-0}" -eq 1 ]]; then
    systemctl restart hxbridge-usb.service
  fi
}

print_urls() {
  local host ips ip
  host="$(hostname)"
  log ""
  log "ToneRelay is installed. Open the editor from a phone or computer on this Wi-Fi:"
  log "  $(editor_url "${host}.local")"
  ips="$(hostname -I 2>/dev/null || true)"
  for ip in $ips; do
    case "$ip" in
      *:*) continue ;;
    esac
    log "  $(editor_url "$ip")"
  done
  if ! systemctl is-active --quiet avahi-daemon.service 2>/dev/null; then
    log "Avahi is not running, so ${host}.local may not resolve. Use the IP address."
  fi
  log ""
  log "Connect the Helix to this Pi with USB if it is not already connected."
  log "If the Helix was already plugged in, unplug it and plug it back in."
}

HXBRIDGE_HTTP_PORT_ENV="${HXBRIDGE_HTTP_PORT:-}"
unset HXBRIDGE_HTTP_PORT || true

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall
  exit 0
fi

if [[ -f /proc/device-tree/model ]]; then
  log "Detected: $(tr -d '\0' </proc/device-tree/model)"
else
  log "warning: this does not look like a Raspberry Pi; continuing anyway"
fi

log "Installing ToneRelay from $ROOT as user $INSTALL_USER."
log "The first compile can take a long time on a Raspberry Pi."

CATALOG_UPDATED=0
install_apt
install_node
choose_port
log "HTTP port: $HXBRIDGE_HTTP_PORT"
write_conf
install_rust
ensure_submodule
build_all
install_catalog
install_udev
install_units
print_urls
