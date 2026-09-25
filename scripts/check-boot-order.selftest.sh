#!/usr/bin/env bash
# check-boot-order.selftest.sh — prove the boot-order guard can actually fail.
#
# A guard only ever seen to pass is not evidence. That argument applies harder
# here than to check-manifest: this guard's entire value is catching a REORDER
# that leaves the event set and the event count identical, which is exactly the
# fault a naive set-comparison would miss while reporting green forever.
#
# It tests the COMPARATOR, by perturbing a copy of the baseline and re-running
# the check against the real app:
#
#   1. REORDER  two adjacent entries swapped — same events, same count
#   2. REMOVAL  one entry deleted
#
# Not by editing the bundle. The first version of this did that, and its
# "reorder" changed nothing: it swapped two listener registrations the trace
# does not record, so the guard passed a bundle the test believed was broken.
# Perturbing the baseline cannot miss in that way — the app is held fixed and
# the expectation is what moves.
#
# WHAT THIS DOES NOT PROVE. The trace records listeners on elements with an id,
# on window and on document — nothing else. A reorder involving only
# class-selected elements is invisible to it. That limit is real; the guard's
# demonstrated catch (eight bootstrap events moved by changing one import's
# POSITION in a feature module) all involved id'd elements and fetches.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
COLD="$HERE/ui/boot-order.baseline.json"
STUBBED="$HERE/ui/boot-order.stubbed.json"
PORT="${BOOT_ORDER_SELFTEST_PORT:-3198}"
TMP="$(mktemp -d)"
SERVER=""
# NOTE: never `kill ${SERVER:-0}` — an unset SERVER makes that `kill 0`, which
# signals the whole process GROUP and kills this script. Cost one debug cycle.
cleanup() { [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null; rm -rf "$TMP"; true; }
trap cleanup EXIT

[ -f "$COLD" ] || { echo "selftest: no baseline to test against" >&2; exit 2; }
[ -f "$STUBBED" ] || { echo "selftest: no stubbed baseline to test against" >&2; exit 2; }

# Which server/baseline pair this run exercises. Both are tested: the stubbed
# baseline covers the wizard, and a fault-detector that only ever ran against
# the cold path would say nothing about that half.
SERVE="${1:-cold}"
if [ "$SERVE" = "stubbed" ]; then
  node "$HERE/ui/stub-serve.mjs" "$HERE/app/public/webchat" "$PORT" &
  BASELINE="$STUBBED"
else
  node "$HERE/ui/static-serve.mjs" "$HERE/app/public/webchat" "$PORT" &
  BASELINE="$COLD"
fi
SERVER=$!
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.2
done

check_against() { ( cd "$HERE/ui" && node boot-order.mjs check "http://127.0.0.1:$PORT/" "$1" ) >/dev/null 2>&1; }

# Sanity: the real baseline must PASS, or the faults below prove nothing.
#
# Retried once, and ONLY this check. Seen 2026-09-17 on the CI runner while
# another job held the box: this check failed, and the unsuppressed re-run
# immediately below it passed against the same bundle and baseline, printing an
# empty diff — the probe had raced the server's first paint, not found a real
# mismatch. The curl loop above proves the port answers, which is weaker than
# the page being ready to instrument.
#
# The retry cannot hide a genuine mismatch: that fails both attempts and still
# lands in the failure path with its diff. A race that resolves is ANNOUNCED
# rather than swallowed, so a probe that starts racing often stays visible
# instead of quietly becoming "the check that always needs two tries".
if ! check_against "$BASELINE"; then
  if check_against "$BASELINE"; then
    echo "  ⚠ committed baseline: passed on RETRY — the first probe raced the server." >&2
    echo "    Not a bundle change (the same baseline passes); if this recurs, the probe" >&2
    echo "    needs a real readiness signal rather than a second attempt." >&2
  else
    echo "❌ selftest: the committed baseline already fails against this bundle." >&2
    echo "   The diff follows. If this change did not mean to touch startup, the DIFF is the" >&2
    echo "   finding — do not re-record to make it green. Re-record (scripts/check-boot-order.sh" >&2
    echo "   --record) only when the change is intended." >&2
    echo "   ---- boot-order diff (${BASELINE##*/}) ----" >&2
    # Re-run unsuppressed. check_against() hides output so the fault cases below
    # stay quiet, but on THIS path the output is the entire point: without it the
    # step says only "re-record me", which is advice, not evidence — and it is
    # exactly wrong whenever the baseline is right and the bundle is not. Cost is
    # one extra trace on a path that is already failing.
    ( cd "$HERE/ui" && node boot-order.mjs check "http://127.0.0.1:$PORT/" "$BASELINE" ) >&2 || true
    exit 1
  fi
fi
echo "  committed baseline: passes (as it must)"

# ── Fault 1: reorder — identical multiset, different sequence ───────────────
python3 - "$BASELINE" "$TMP/reordered.json" <<'PY'
import json, sys
b = json.load(open(sys.argv[1]))
if len(b) < 2:
    sys.exit("selftest: baseline too short to reorder")
# Swap the first two entries that actually differ, so the permutation is real.
i = next((k for k in range(len(b) - 1) if b[k] != b[k + 1]), None)
if i is None:
    sys.exit("selftest: every baseline entry is identical; cannot build a reorder")
b[i], b[i + 1] = b[i + 1], b[i]
json.dump(b, open(sys.argv[2], 'w'))
PY
if check_against "$TMP/reordered.json"; then
  echo "❌ selftest: the guard PASSED a reordered expectation — it is not order-sensitive." >&2
  exit 1
fi
echo "  reordered baseline: rejected ✓"

# ── Fault 2: removal ────────────────────────────────────────────────────────
python3 - "$BASELINE" "$TMP/short.json" <<'PY'
import json, sys
b = json.load(open(sys.argv[1]))
del b[len(b) // 2]
json.dump(b, open(sys.argv[2], 'w'))
PY
if check_against "$TMP/short.json"; then
  echo "❌ selftest: the guard PASSED a baseline with an event removed." >&2
  exit 1
fi
echo "  truncated baseline: rejected ✓"

# The connectivity probe fires on a reconnect timer (ui/boot-order.mjs TIMED):
# moved, it must still pass; missing, it must still fail. Skipped when this
# baseline never drops the socket (no probe recorded).
if grep -q 'generate_204' "$BASELINE"; then
  python3 - "$BASELINE" "$TMP/probe-moved.json" "$TMP/probe-gone.json" <<'PY'
import json, sys
b = json.load(open(sys.argv[1]))
probe = [e for e in b if e.endswith('/generate_204')]
rest = [e for e in b if not e.endswith('/generate_204')]
json.dump(probe + rest, open(sys.argv[2], 'w'))
json.dump(rest + probe[1:], open(sys.argv[3], 'w'))
PY
  if ! check_against "$TMP/probe-moved.json"; then
    echo "❌ selftest: the guard REJECTED a baseline whose timer-driven probe moved." >&2
    exit 1
  fi
  echo "  probe moved: accepted ✓"
  if check_against "$TMP/probe-gone.json"; then
    echo "❌ selftest: the guard PASSED a baseline missing a probe fetch." >&2
    exit 1
  fi
  echo "  probe missing: rejected ✓"
fi

echo "✅ boot-order guard is order-sensitive and set-sensitive ($SERVE)"
