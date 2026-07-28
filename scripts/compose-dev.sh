#!/usr/bin/env bash
# Dev harness: compose a working nanoclaw tree with this repo's app tree
# SYMLINKED in, so edits made in the composed tree land in this repo's
# working copy (and vice versa). Residue patches are applied as real edits —
# regen them with regen-patches.sh before committing changes to patched files.
#
#   scripts/compose-dev.sh [/tmp/nanoclaw-composed]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-/tmp/nanoclaw-composed}"

bash "$HERE/install.sh" --dir "$TARGET"          # clone + seam + patches + build

# Replace copied app files with symlinks into this repo.
while IFS= read -r rel; do
  [ -z "$rel" ] && continue
  src="$HERE/app/$rel"
  dst="$TARGET/$rel"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    ln -sf "$src" "$dst"
  elif [ -d "$src" ]; then
    rm -rf "$dst"
    ln -sfn "$src" "$dst"
  fi
done < "$HERE/app-manifest.txt"

echo "Composed tree at $TARGET (app tree symlinked into $HERE/app)"
echo "Run tests there:  cd $TARGET && pnpm exec vitest run"
