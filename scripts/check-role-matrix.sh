#!/usr/bin/env bash
# check-role-matrix.sh — does the UI offer anyone a control they cannot use?
#
#   scripts/check-role-matrix.sh              # assert the matrix
#   scripts/check-role-matrix.sh --selftest   # prove the guard can fail
#
# Serves the built bundle with stub-serve (canned API, first-run install) and
# drives it as three personas — non-owner, owner, scoped admin — asserting both
# halves: what must be hidden AND what must be visible. See ui/role-matrix.mjs
# for why this is measured in a browser rather than read out of the source.
#
# This exists because three privilege-leak bugs shipped in a row, and the source
# said the opposite of the truth every time.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$HERE/app/public/webchat"
PORT="${ROLE_MATRIX_PORT:-3211}"
SERVER=""
# Never `kill ${SERVER:-0}` — an unset SERVER makes that `kill 0`, which signals
# the whole process GROUP and takes this script with it.
cleanup() { [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null; true; }
trap cleanup EXIT

[ -f "$ROOT/app.js" ] || { echo "check-role-matrix: no $ROOT/app.js — build the UI first" >&2; exit 2; }

node "$HERE/ui/stub-serve.mjs" "$ROOT" "$PORT" &
SERVER=$!
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.2
done

cd "$HERE/ui"

if [ "${1:-}" = "--selftest" ]; then
  # Fault injection: strip `hidden` off the gated controls on a timer, which is
  # what a removed or skipped gate looks like from the outside. The guard must
  # reject it. A guard only ever seen to pass is not evidence.
  echo "selftest: running with a simulated missing gate — the guard MUST fail"
  if node role-matrix.mjs "http://127.0.0.1:$PORT/" --inject-fault >/dev/null 2>&1; then
    echo "❌ selftest: the guard PASSED a build with the gates removed." >&2
    exit 1
  fi
  echo "  simulated missing gate: rejected ✓"
  # …and it must still pass the unperturbed build, or it is just always-red.
  if ! node role-matrix.mjs "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "❌ selftest: the guard FAILED the real build — it is not discriminating, just broken." >&2
    exit 1
  fi
  echo "  unperturbed build: accepted ✓"
  echo "✅ role-matrix guard detects a missing gate"
  exit 0
fi

node role-matrix.mjs "http://127.0.0.1:$PORT/"
