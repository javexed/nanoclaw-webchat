#!/usr/bin/env bash
# Regenerate patches/ from a composed tree.
#
# In a composed tree, git HEAD is the seam merge commit and every patched
# file is a modified TRACKED file — so the current patch content for file F
# is exactly `git diff HEAD -- F`. After editing a patched file in the
# composed tree (e.g. an adaptation pass), run this to rewrite its patch:
#
#   scripts/regen-patches.sh <composed-tree> [file ...]
#
# With no files given, ALL existing patches regenerate. A file whose diff
# has become empty (fully adapted — the seam now provides everything) has
# its patch DELETED, which is the goal state.
#
# Lesson (learned the hard way): commit this repo BEFORE regenerating, so a
# bad regen is a `git checkout patches/` away from undone.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TREE="${1:?composed tree}"; shift || true

if [ $# -gt 0 ]; then
  FILES=("$@")
else
  FILES=()
  for p in "$HERE/patches/"*/*.patch; do
    n="${p##*/}"
    FILES+=("$(echo "${n%.patch}" | sed 's|__|/|g')")
  done
fi

# Locate an existing patch across the destiny sub-folders (upstreamable/,
# product/, local/ — see patches/INVENTORY.md). A NEW patch lands in
# product/ by default; move it and add an INVENTORY line if it is really a
# generic fix bound for upstream.
find_patch() {
  local name="$1"
  for d in upstreamable product local; do
    [ -f "$HERE/patches/$d/$name" ] && { echo "$HERE/patches/$d/$name"; return; }
  done
  echo "$HERE/patches/product/$name"
}

for f in "${FILES[@]}"; do
  name="$(echo "$f" | sed 's|/|__|g').patch"
  target="$(find_patch "$name")"
  diff_out=$(git -C "$TREE" diff HEAD -- "$f")
  if [ -z "$diff_out" ]; then
    if [ -f "$target" ]; then
      rm "$target"
      echo "  ✂ $f: fully adapted — patch deleted (${target#$HERE/patches/})"
    else
      echo "  = $f: no diff, no patch"
    fi
  else
    printf '%s\n' "$diff_out" > "$target"
    echo "  → $f: patch regenerated (${target#$HERE/patches/}, $(printf '%s\n' "$diff_out" | grep -c '^[+-]') diff lines)"
  fi
done
