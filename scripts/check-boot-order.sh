#!/usr/bin/env bash
# check-boot-order.sh — did the startup sequence change?
#
#   scripts/check-boot-order.sh            # compare against the baseline
#   scripts/check-boot-order.sh --record   # accept the current order as the baseline
#
# Serves app/public/webchat statically (no backend, every /api 404s) and drives
# it with Playwright, recording listener registrations, fetches and storage
# reads in the order they happen. See ui/boot-order.mjs for why a set-based
# check cannot replace this.
#
# Re-recording is a DELIBERATE act. If a diff appears in a PR that did not mean
# to touch startup, the diff is the finding — do not re-record to make it green.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$HERE/app/public/webchat"
# TWO baselines, because one server cannot show both shapes.
#
#   cold     static-serve, every /api 404s — the no-backend boot path
#   stubbed  stub-serve, canned API reporting a FIRST-RUN install
#
# The cold one alone left 25 events uncovered, the whole wizard among them —
# including on:wizard-ollama-probe:click. A real install cannot substitute:
# once onboarded it never opens the wizard either.
COLD="$HERE/ui/boot-order.baseline.json"
STUBBED="$HERE/ui/boot-order.stubbed.json"
PORT="${BOOT_ORDER_PORT:-3199}"
PORT2=$((PORT + 1))

[ -f "$ROOT/index.html" ] || { echo "check-boot-order: no $ROOT/index.html" >&2; exit 2; }
[ -f "$ROOT/app.js" ] || { echo "check-boot-order: no $ROOT/app.js — build the UI first" >&2; exit 2; }

node "$HERE/ui/static-serve.mjs" "$ROOT" "$PORT" &
SERVER=$!
node "$HERE/ui/stub-serve.mjs" "$ROOT" "$PORT2" &
SERVER2=$!
trap 'kill $SERVER $SERVER2 2>/dev/null || true' EXIT

# Wait for the port rather than sleeping a fixed amount — a cold runner is slow
# and a fixed sleep is either flaky or wasteful.
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null \
     && curl -fsS -o /dev/null "http://127.0.0.1:$PORT2/" 2>/dev/null; then break; fi
  sleep 0.2
done

cd "$HERE/ui"
if [ "${1:-}" = "--record" ]; then
  node boot-order.mjs record "http://127.0.0.1:$PORT/" > "$COLD"
  node boot-order.mjs record "http://127.0.0.1:$PORT2/" > "$STUBBED"
  echo "recorded cold $(python3 -c "import json;print(len(json.load(open('$COLD'))))") / stubbed $(python3 -c "import json;print(len(json.load(open('$STUBBED'))))") events"
  exit 0
fi

[ -f "$COLD" ] || { echo "check-boot-order: no baseline; run with --record" >&2; exit 2; }
[ -f "$STUBBED" ] || { echo "check-boot-order: no stubbed baseline; run with --record" >&2; exit 2; }
echo "cold (no backend):"
node boot-order.mjs check "http://127.0.0.1:$PORT/" "$COLD"
echo "stubbed (first-run install):"
node boot-order.mjs check "http://127.0.0.1:$PORT2/" "$STUBBED"
