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

# The web app runs as the unprivileged system user "quadeck"; only the small
# helper runs as root (fixed list of actions, unlock with an admin password).
if ! getent group quadeck >/dev/null; then groupadd --system quadeck; fi
if ! id quadeck >/dev/null 2>&1; then
  useradd --system --gid quadeck --home-dir /var/lib/quadeck --no-create-home --shell /usr/sbin/nologin quadeck
fi
getent group systemd-journal >/dev/null && usermod -aG systemd-journal quadeck
# Earlier versions ran everything as root: hand the data over.
[ -d /var/lib/quadeck ] && chown -R quadeck:quadeck /var/lib/quadeck

"$BIN_DIR/quadeck" print-unit helper | sed "s#/usr/local/bin/quadeck#$BIN_DIR/quadeck#" > /etc/systemd/system/quadeck-helper.service
"$BIN_DIR/quadeck" print-unit web | sed "s#/usr/local/bin/quadeck#$BIN_DIR/quadeck#" > /etc/systemd/system/quadeck.service
systemctl daemon-reload
systemctl enable quadeck-helper.service quadeck.service
systemctl restart quadeck-helper.service quadeck.service

if ! systemctl is-enabled --quiet podman.socket 2>/dev/null; then
  echo "Hinweis: podman.socket ist nicht aktiv. Für die Container-Ansicht:"
  echo "  systemctl enable --now podman.socket"
fi

port=$(sed -n 's/^QUADECK_PORT=//p' /etc/quadeck/quadeck.env 2>/dev/null || true)
port=${port:-8484}
# Primary IPv4 (works everywhere iproute2 exists; Arch has no `hostname -I`).
host=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
[ -n "$host" ] || host=$(hostname -I 2>/dev/null | awk '{print $1}')
sleep 1
token=$(QUADECK_DATA_DIR=/var/lib/quadeck "$BIN_DIR/quadeck" setup-token 2>/dev/null || true)
echo
case "$token" in
  "" | Passwort*) echo "Quadeck läuft: http://${host:-<host>}:$port" ;;
  *) echo "Quadeck läuft. Ersteinrichtung: http://${host:-<host>}:$port/setup?token=$token" ;;
esac
