#!/usr/bin/env bash
# check-wiring-remount.sh — does the Wiring view survive being rendered twice?
#
#   scripts/check-wiring-remount.sh            # assert it renders every time
#   scripts/check-wiring-remount.sh --selftest # prove the probe can still fail
#
# WHY THIS EXISTS. Reported from the field: Wiring sat on "Loading…" forever.
# `#matrix-canvas` is BOTH the placeholder target and the island's mount host,
# so `canvas.textContent = 'Loading…'` wiped the mounted app's DOM, while
# `mountMatrix()` refused to rebuild because `matrixApp` was still set and was
# never unmounted. First render fine; every render after it dead until reload.
#
# It is a MOUNT-HOST COLLISION, not a data problem — /api/topology answered in
# 2ms with correct JSON throughout. That is why it survived review and every
# existing guard: nothing was red, the fetch was fine, and a first look at the
# view works. Only the second render shows it.
#
# The same shape can recur for any island whose host doubles as a status
# target, so this drives all three entrances: first open, Refresh (the refresh
# handler), and close + reopen (teardown). Different code paths, one collision.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$HERE/app/public/webchat"
PORT="${WIRING_REMOUNT_PORT:-3196}"

[ -f "$ROOT/index.html" ] || { echo "check-wiring-remount: no $ROOT/index.html" >&2; exit 2; }
[ -f "$ROOT/app.js" ] || { echo "check-wiring-remount: no $ROOT/app.js — build the UI first" >&2; exit 2; }

node "$HERE/ui/static-serve.mjs" "$ROOT" "$PORT" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.2
done

if [ "${1:-}" = "--selftest" ]; then
  # Put the bug back: strip the unmount so the island is never released, which
  # is exactly the state that shipped. Then require the probe to go red.
  BAK="$(mktemp)"
  cp "$ROOT/app.js" "$BAK"
  restore() { cp "$BAK" "$ROOT/app.js"; rm -f "$BAK"; kill $SERVER 2>/dev/null || true; }
  trap restore EXIT

  python3 - "$ROOT/app.js" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
# Reinject the fault that actually shipped: paint the placeholder into the
# island's mount host UNCONDITIONALLY. That is the load-bearing half.
#
# Established by this selftest failing honestly: stripping the unmount alone
# did NOT reproduce, because with the placeholder guarded the host is never
# wiped, so the still-mounted island keeps rendering. The unmount is hygiene
# (release the app, allow a clean rebuild); the guard is the fix.
#
# Note `matrixApp$1` — the bundler renames it, since the permissions matrix has
# its own `matrixApp`, and `$` is not \w. A \w+ pattern silently matches
# nothing here, which is exactly how a selftest rots into a meaningless green.
pat = re.compile(r'if \(![\w$]*[Mm]atrix[\w$]*\) (canvas\.textContent = "Loading…";)')
s2, n = pat.subn(r'\1', s)
if n == 0:
    sys.exit('selftest: could not find the guarded placeholder write — update the pattern')
open(p, 'w').write(s2)
print(f'  selftest: removed {n} placeholder guard(s), restoring the shipped bug')
PY

  cd "$HERE/ui"
  set +e
  node wiring-remount-probe.mjs "http://127.0.0.1:$PORT/" >/dev/null 2>&1
  rc=$?
  set -e
  if [ "$rc" = "0" ]; then
    echo "❌ selftest: the probe PASSED with the unmount removed." >&2
    echo "   It is not detecting the fault it exists to catch." >&2
    exit 1
  fi
  if [ "$rc" != "1" ]; then
    echo "❌ selftest: the probe exited $rc (could not drive the page), not 1." >&2
    echo "   That is a broken probe, not a detected fault. Run it directly." >&2
    exit 1
  fi
  echo "  selftest: probe correctly fails when the placeholder can wipe the island"
  exit 0
fi

cd "$HERE/ui"
node wiring-remount-probe.mjs "http://127.0.0.1:$PORT/"
