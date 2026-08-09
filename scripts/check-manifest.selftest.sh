#!/usr/bin/env bash
# Self-test for check-manifest.sh.
#
#   scripts/check-manifest.selftest.sh
#
# A guard that has only ever been seen to pass is not evidence of anything.
# This builds throwaway fixture trees and asserts the guard FAILS on each
# real fault shape, and passes on a clean one. It never touches the repo's
# own app/ or app-manifest.txt.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$HERE/scripts/check-manifest.sh"

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0

# Build a fixture root: app/ tree + manifest, both fully specified by args.
fixture() { # fixture <name> <manifest-lines> <files>
  local root="$WORK/$1"; mkdir -p "$root/app"
  printf '%s\n' $2 > "$root/app-manifest.txt"
  local f
  for f in $3; do mkdir -p "$root/app/$(dirname "$f")"; echo 'x' > "$root/app/$f"; done
  echo "$root"
}

expect() { # expect <want-rc> <name> <root> <want-substring>
  local want=$1 name=$2 root=$3 needle=$4 out rc
  out=$(bash "$GUARD" "$root" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$want" ] && grep -q "$needle" <<<"$out"; then
    echo "  ok   $name"; PASS=$((PASS+1))
  else
    echo "  FAIL $name (rc=$rc want=$want)"; echo "$out" | sed 's/^/       /'
    FAIL=$((FAIL+1))
  fi
}

echo "check-manifest self-test"

expect 0 "clean tree passes" \
  "$(fixture clean 'src/mod src/db/migrations/m-one.ts' 'src/mod/a.ts src/db/migrations/m-one.ts')" \
  'manifest OK'

# The high-severity one: the file ships (install.sh copies the tree wholesale)
# but install.sh never registers it, so the migration silently never runs.
expect 1 "migration with no exact entry is caught" \
  "$(fixture unreg 'src/mod' 'src/mod/a.ts src/db/migrations/m-one.ts')" \
  'NEVER REGISTERED'

# A directory entry covers the path for the dev tree but does NOT register the
# migration — install.sh matches manifest lines, not prefixes.
expect 1 "directory entry does not count as registration" \
  "$(fixture dircover 'src/db/migrations' 'src/db/migrations/m-one.ts')" \
  'NEVER REGISTERED'

expect 1 "uncovered file diverges the dev tree" \
  "$(fixture uncovered 'src/mod' 'src/mod/a.ts src/other/b.ts')" \
  'MISSING FROM DEV TREE'

expect 1 "dangling entry is caught" \
  "$(fixture dangling 'src/mod src/gone.ts' 'src/mod/a.ts')" \
  'DANGLING'

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
