#!/bin/sh
# Smoke test for one distribution (CI runs it in a container of each): the release binary starts,
# finds the distribution and its package manager, and serves the web app.
#   scripts/smoke-distro.sh <binary> <os-id> <package-manager>
set -eu
bin=$1 id=$2 pm=$3

"$bin" version
"$bin" doctor
"$bin" doctor --json --expect "osIds=$id" --expect "packageManager=$pm" >/dev/null

data=$(mktemp -d)
QUADECK_DATA_DIR=$data QUADECK_PORT=8484 QUADECK_HOST=127.0.0.1 "$bin" serve >"$data/log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
# curl, BusyBox wget or bash's /dev/tcp: whatever the bare image has
health() {
  if command -v curl >/dev/null; then curl -fsS http://127.0.0.1:8484/api/health
  elif command -v wget >/dev/null; then wget -qO- http://127.0.0.1:8484/api/health
  else bash -c 'exec 3<>/dev/tcp/127.0.0.1/8484 && printf "GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n" >&3 && cat <&3' | tail -n 1; fi
}
out=
for _ in $(seq 1 30); do
  out=$(health 2>/dev/null || true)
  case "$out" in *'"ok":true'*) break ;; esac
  out=
  sleep 1
done
if [ -z "$out" ]; then
  cat "$data/log"
  echo "smoke: no answer from /api/health" >&2
  exit 1
fi
echo "health: $out"
