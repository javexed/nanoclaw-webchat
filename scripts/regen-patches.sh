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
  # `find`, not a glob: `*/*.patch` does not match a leading dot, so a bare
  # regen silently skipped every dotfile patch (.gitignore, .claude/skills/*)
  # — the same blind spot that kept install.sh from applying them at all.
  FILES=()
  while IFS= read -r p; do
    n="${p##*/}"
    FILES+=("$(echo "${n%.patch}" | sed 's|__|/|g')")
  done < <(find "$HERE/patches" -mindepth 2 -maxdepth 2 -name '*.patch' | sort)
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

# Refuse to regenerate a patch that is NOT APPLIED in the target tree.
#
# A patch is derived from `git diff HEAD -- F` in the composed tree. If the
# patch was never applied there, that diff cannot contain its hunks — so
# regenerating REDUCES the patch to whatever you just changed, silently
# discarding the rest. That is not hypothetical: the dotfile-glob bug meant six
# patches were never applied, and regenerating .gitignore.patch cut it from
# three hunks to one.
#
# The test is whether the patch still applies FORWARD. If it does, its changes
# are absent from the tree — it was never applied, and diffing is unsafe. If it
# fails (already applied, possibly plus your edits), that is the normal case.
#
# The pre-existing rule — commit before regenerating — makes a bad regen
# recoverable. This makes it not happen. Set REGEN_FORCE=1 to override
# deliberately (e.g. re-deriving a patch you know is stale).
assert_applied() {
  local f="$1" target="$2"
  [ -f "$target" ] || return 0                       # new patch: nothing to lose
  [ "${REGEN_FORCE:-0}" = 1 ] && return 0
  if git -C "$TREE" apply --check "$target" 2>/dev/null; then
    echo "  !! $f: its patch is NOT APPLIED in $TREE — refusing to regenerate." >&2
    echo "     Regenerating would reduce ${target#$HERE/patches/} to only your current edit." >&2
    echo "     Compose the tree again (the patch should apply), or REGEN_FORCE=1 to override." >&2
    return 1
  fi
  return 0
}

RC=0
for f in "${FILES[@]}"; do
  name="$(echo "$f" | sed 's|/|__|g').patch"
  target="$(find_patch "$name")"
  if ! assert_applied "$f" "$target"; then RC=1; continue; fi
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
exit $RC
