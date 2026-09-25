#!/usr/bin/env bash
# check-async.selftest.sh — prove check-async.sh still catches a dropped Promise,
# and still ignores one on a line our patch did not add.
#
#   scripts/check-async.selftest.sh <composed-tree>
set -uo pipefail

TREE="${1:?usage: check-async.selftest.sh <composed-tree>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROBE="src/async-probe-selftest.ts"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT" "$TREE/$PROBE"' EXIT

cat > "$TREE/$PROBE" <<'EOF'
async function work(): Promise<void> {}
export function caller(): void {
  work();
}
EOF

fail=0
# 1. The file is ours in full: the dropped Promise on line 3 must fail the gate.
mkdir -p "$ROOT/app/src"
touch "$ROOT/app/$PROBE"
if CHECK_ASYNC_ROOT="$ROOT" bash "$HERE/scripts/check-async.sh" "$TREE" > "$ROOT/out" 2>&1; then
  echo "❌ selftest: a floating promise in an owned file passed" >&2; fail=1
elif ! grep -q "$PROBE:3" "$ROOT/out"; then
  echo "❌ selftest: failed, but did not name $PROBE:3" >&2; cat "$ROOT/out" >&2; fail=1
fi

# 2. The file is upstream and our patch added only line 1: line 3 is not ours.
rm -rf "$ROOT/app"
mkdir -p "$ROOT/patches/product"
cat > "$ROOT/patches/product/src__async-probe-selftest.ts.patch" <<'EOF'
--- a/src/async-probe-selftest.ts
+++ b/src/async-probe-selftest.ts
@@ -0,0 +1,1 @@
+async function work(): Promise<void> {}
EOF
if ! CHECK_ASYNC_ROOT="$ROOT" bash "$HERE/scripts/check-async.sh" "$TREE" > "$ROOT/out" 2>&1; then
  echo "❌ selftest: a floating promise on an upstream line failed the gate" >&2; cat "$ROOT/out" >&2; fail=1
fi

[ "$fail" -eq 0 ] && echo "check-async selftest OK: catches an owned dropped Promise, ignores an upstream one"
exit "$fail"
