#!/usr/bin/env bash
# check-unused.selftest.sh — prove check-unused.sh still catches an unused import
# and an unused local, and still ignores them on lines our patch did not add.
#
#   scripts/check-unused.selftest.sh <composed-tree>
set -uo pipefail

TREE="${1:?usage: check-unused.selftest.sh <composed-tree>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROBE="src/unused-probe-selftest.ts"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT" "$TREE/$PROBE"' EXIT

cat > "$TREE/$PROBE" <<'EOF'
import { readFileSync } from 'fs';
export const kept = 1;
const unused = 2;
EOF

fail=0
# 1. The file is ours in full: the unused import (line 1) and local (line 3) must fail.
mkdir -p "$ROOT/app/src"
touch "$ROOT/app/$PROBE"
if CHECK_ASYNC_ROOT="$ROOT" bash "$HERE/scripts/check-unused.sh" "$TREE" > "$ROOT/out" 2>&1; then
  echo "❌ selftest: an unused import and local in an owned file passed" >&2; fail=1
elif ! grep -q "$PROBE:1" "$ROOT/out" || ! grep -q "$PROBE:3" "$ROOT/out"; then
  echo "❌ selftest: failed, but did not name $PROBE:1 and :3" >&2; cat "$ROOT/out" >&2; fail=1
fi

# 2. The file is upstream and our patch added only line 2: lines 1 and 3 are not ours.
rm -rf "$ROOT/app"
mkdir -p "$ROOT/patches/product"
cat > "$ROOT/patches/product/src__unused-probe-selftest.ts.patch" <<'EOF'
--- a/src/unused-probe-selftest.ts
+++ b/src/unused-probe-selftest.ts
@@ -1,2 +1,3 @@
 import { readFileSync } from 'fs';
+export const kept = 1;
 const unused = 2;
EOF
if ! CHECK_ASYNC_ROOT="$ROOT" bash "$HERE/scripts/check-unused.sh" "$TREE" > "$ROOT/out" 2>&1; then
  echo "❌ selftest: unused names on upstream lines failed the gate" >&2; cat "$ROOT/out" >&2; fail=1
fi

[ "$fail" -eq 0 ] && echo "check-unused selftest OK: catches an owned unused import and local, ignores upstream ones"
exit "$fail"
