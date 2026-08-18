#!/usr/bin/env bash
# check-first-open.sh — does tapping a room on a still-connecting socket open it?
#
#   scripts/check-first-open.sh              # assert the room opens
#   scripts/check-first-open.sh --selftest   # prove the probe can still fail
#
# WHY THIS EXISTS. Reported from the field: the first room tapped after opening
# the app did not open, and tapping a different room and then tapping back
# "fixed" it. The cause was `state.ws?.send(...)` in joinRoom — `?.` guards a
# NULL socket but not a CONNECTING one, and send() on a connecting socket
# THROWS. The throw landed mid-function, so the room name, the enabled
# composer, the thread list and the lastRoom write below it never ran.
#
# The window only exists on RESUME. Room rows come from the WS `rooms` message,
# so a cold load has nothing to click until the socket is already open; but
# returning to a backgrounded tab calls connect() while the previous session's
# rows are still painted. That is the state this probe recreates, and it is why
# a plain "load the page and click" test would never have caught it.
#
# The selftest perturbs the FIX, not the probe: it rebuilds a bundle whose
# joinRoom sends unguarded and asserts the probe goes red. A probe only ever
# seen green is not evidence.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$HERE/app/public/webchat"
PORT="${FIRST_OPEN_PORT:-3197}"

[ -f "$ROOT/index.html" ] || { echo "check-first-open: no $ROOT/index.html" >&2; exit 2; }
[ -f "$ROOT/app.js" ] || { echo "check-first-open: no $ROOT/app.js — build the UI first" >&2; exit 2; }

node "$HERE/ui/static-serve.mjs" "$ROOT" "$PORT" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.2
done

if [ "${1:-}" = "--selftest" ]; then
  # Restore the unguarded send in a scratch copy of the bundle, and require the
  # probe to fail against it.
  BAK="$(mktemp)"
  cp "$ROOT/app.js" "$BAK"
  restore() { cp "$BAK" "$ROOT/app.js"; rm -f "$BAK"; kill $SERVER 2>/dev/null || true; }
  trap restore EXIT

  # The built bundle guards the join with a readyState test. Strip that test so
  # the send runs unconditionally, which is precisely the shipped bug.
  python3 - "$ROOT/app.js" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
# Drop the `if (OPEN)` prefix from the JOIN sends only, leaving the send itself
# — which is the pre-fix code. Anchored on the `type: "join"` payload so the
# guarded `read`/`interrupt` sends elsewhere are left alone.
pat = re.compile(
    r'if \(state\.ws && state\.ws\.readyState === WebSocket\.OPEN\) '
    r'(state\.ws\.send\(JSON\.stringify\(\{\s*type: "join")'
)
s2, n = pat.subn(r'\1', s)
if n == 0:
    sys.exit("selftest: could not find the guarded join in the bundle — update the pattern")
open(p, 'w').write(s2)
print(f"  selftest: removed {n} readyState guard(s) from the bundle")
PY

  cd "$HERE/ui"
  set +e
  node first-open-probe.mjs "http://127.0.0.1:$PORT/" >/dev/null 2>&1
  rc=$?
  set -e
  # Exit 1 means "reproduced the fault", which is what we want here. Exit 2 is
  # the probe failing to drive the page at all — accepting that as a pass would
  # let a BROKEN probe pose as a working detector, which is the exact failure
  # this selftest exists to prevent. Distinguish them.
  if [ "$rc" = "0" ]; then
    echo "❌ selftest: the probe PASSED against a bundle with the bug reintroduced." >&2
    echo "   It is not detecting the fault it exists to catch." >&2
    exit 1
  fi
  if [ "$rc" != "1" ]; then
    echo "❌ selftest: the probe exited $rc (could not drive the page), not 1." >&2
    echo "   That is a broken probe, not a detected fault. Run it directly to see why." >&2
    exit 1
  fi
  echo "  selftest: probe correctly fails when the guard is removed"
  exit 0
fi

cd "$HERE/ui"
node first-open-probe.mjs "http://127.0.0.1:$PORT/"
