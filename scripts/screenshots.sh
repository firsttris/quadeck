#!/usr/bin/env bash
# Takes the screenshots in docs/ (scripts/screenshots.mjs) against a production build with the demo
# data from fixtures/demo, then stops the server again: bun run screenshots
# The workflow "Update screenshots" runs it in the Playwright image and commits the pictures.
set -euo pipefail
PORT=8686
rm -rf .shot-data
bun run build
QUADECK_PORT=$PORT QUADECK_HOST=127.0.0.1 QUADECK_DATA_DIR=.shot-data QUADECK_FIXTURES=fixtures/demo QUADECK_UNLOCK=quadeck \
  bun scripts/start.ts &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
for i in $(seq 120); do
  bun -e "process.exit((await fetch('http://127.0.0.1:$PORT/api/health').catch(() => null))?.ok ? 0 : 1)" && break
  (( i == 120 )) && { echo "The server did not start" >&2; exit 1; }
  sleep 1
done
node scripts/screenshots.mjs docs
