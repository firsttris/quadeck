#!/bin/sh
# Quadeck installer: downloads the binary for this machine from GitHub
# Releases, verifies its checksum and sets up the systemd service.
#   curl -fsSL https://raw.githubusercontent.com/firsttris/quadeck/main/install.sh | sudo sh
set -eu

REPO="firsttris/quadeck"
BIN_DIR="${QUADECK_BIN_DIR:-/usr/local/bin}"
VERSION="${QUADECK_VERSION:-latest}"

die() { echo "quadeck: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "bitte als root ausführen (sudo)"
command -v curl >/dev/null || die "curl wird benötigt"

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "nicht unterstützte Architektur: $(uname -m)" ;;
esac

if [ -f /etc/alpine-release ] || ls /lib/ld-musl-* >/dev/null 2>&1; then
  asset="quadeck-linux-$arch-musl"
elif [ "$arch" = x64 ]; then
  asset="quadeck-linux-x64-baseline" # also runs on CPUs without AVX2
else
  asset="quadeck-linux-arm64"
fi

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Lade $asset …"
curl -fsSL -o "$tmp/$asset" "$base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
(cd "$tmp" && grep " $asset\$" SHA256SUMS | sha256sum -c -) || die "Prüfsumme stimmt nicht"

mkdir -p "$BIN_DIR"
install -m 0755 "$tmp/$asset" "$BIN_DIR/quadeck"
echo "Installiert: $BIN_DIR/quadeck ($("$BIN_DIR/quadeck" version))"

if ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then
  echo "Kein systemd gefunden: Quadeck läuft, der systemd-Teil bleibt ausgeblendet."
  echo "Starten mit: QUADECK_DATA_DIR=/var/lib/quadeck $BIN_DIR/quadeck serve"
  exit 0
fi

"$BIN_DIR/quadeck" print-unit | sed "s#/usr/local/bin/quadeck#$BIN_DIR/quadeck#" > /etc/systemd/system/quadeck.service
systemctl daemon-reload
systemctl enable --now quadeck.service
systemctl restart quadeck.service

if ! systemctl is-enabled --quiet podman.socket 2>/dev/null; then
  echo "Hinweis: podman.socket ist nicht aktiv. Für die Container-Ansicht:"
  echo "  systemctl enable --now podman.socket"
fi

port=$(sed -n 's/^QUADECK_PORT=//p' /etc/quadeck/quadeck.env 2>/dev/null || true)
port=${port:-8484}
host=$(hostname -I 2>/dev/null | awk '{print $1}')
sleep 1
token=$(QUADECK_DATA_DIR=/var/lib/quadeck "$BIN_DIR/quadeck" setup-token 2>/dev/null || true)
echo
case "$token" in
  "" | Passwort*) echo "Quadeck läuft: http://${host:-<host>}:$port" ;;
  *) echo "Quadeck läuft. Ersteinrichtung: http://${host:-<host>}:$port/setup?token=$token" ;;
esac
