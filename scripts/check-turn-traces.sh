#!/usr/bin/env bash
# check-turn-traces.sh — do a reply's Thoughts load on demand, the same live and stored?
#
#   scripts/check-turn-traces.sh              # assert it in a browser
#   scripts/check-turn-traces.sh --selftest   # prove the probe can still fail
#
# Drives the built bundle against a fake socket (ui/trace-probe.mjs): history
# must flag, not fetch; the first open fetches once and renders harness · model
# · host, tools and reasoning; the live bubble and its reply render the same
# view. The selftest drops the history flag from a scratch copy of the bundle
# and requires the probe to go red.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$HERE/app/public/webchat"
PORT="${TRACE_PROBE_PORT:-3198}"

[ -f "$ROOT/app.js" ] || { echo "check-turn-traces: no $ROOT/app.js — build the UI first" >&2; exit 2; }

node "$HERE/ui/static-serve.mjs" "$ROOT" "$PORT" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.2
done

if [ "${1:-}" = "--selftest" ]; then
  BAK="$(mktemp)"
  cp "$ROOT/app.js" "$BAK"
  restore() { cp "$BAK" "$ROOT/app.js"; rm -f "$BAK"; kill $SERVER 2>/dev/null || true; }
  trap restore EXIT
  python3 - "$ROOT/app.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
needle = 'hasTrace: msg.has_trace === true'
if needle not in s:
    sys.exit("selftest: could not find the has_trace mapping in the bundle — update the pattern")
open(p, 'w').write(s.replace(needle, 'hasTrace: false'))
print("  selftest: dropped the history has_trace flag from the bundle")
PY
  cd "$HERE/ui"
  set +e
  node trace-probe.mjs "http://127.0.0.1:$PORT/" >/dev/null 2>&1
  rc=$?
  set -e
  if [ "$rc" = "0" ]; then
    echo "❌ selftest: the probe PASSED against a bundle that ignores has_trace." >&2
    exit 1
  fi
  if [ "$rc" != "1" ]; then
    echo "❌ selftest: the probe exited $rc (could not drive the page), not 1." >&2
    exit 1
  fi
  echo "  selftest: probe correctly fails when history loses its trace flag"
  exit 0
fi

cd "$HERE/ui"
node trace-probe.mjs "http://127.0.0.1:$PORT/"
