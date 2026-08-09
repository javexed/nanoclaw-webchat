#!/usr/bin/env bash
# check-format.sh — is the composed tree prettier-clean?
#
#   scripts/check-format.sh <composed-tree>
#
# WHY THIS EXISTS. The composed tree carries a `format:fix` pre-commit hook from
# upstream. On 2026-07-29 a deploy committed the composed tree into the live
# install, the hook fired, and prettier rewrote 27 files *after* the sync — so
# the running install no longer matched the artifact that the release gates had
# actually tested. Formatting-only, but it means "deployed == released" stops
# being true, and it recurs on every single deploy.
#
# The drift was entirely ours: 28 app/-owned files plus 3 whose patches
# introduced unformatted hunks. Zero upstream files were dirty — upstream runs
# its own format check, so its tree arrives clean and only our payload can spoil
# it.
#
# SCOPE IS DELIBERATE. This checks only paths this repo owns (app/ overlay +
# patched files), never the whole composed tree. Checking everything would make
# our gate red whenever UPSTREAM ships an unformatted file — a failure we cannot
# fix and would learn to ignore, which is how a gate dies.
set -uo pipefail

TREE="${1:?usage: check-format.sh <composed-tree>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$TREE" ] || { echo "not a directory: $TREE" >&2; exit 2; }

# Paths we own: everything under app/ plus every file a patch rewrites.
OWNED=()
while IFS= read -r f; do OWNED+=("${f#"$HERE/app/"}"); done \
  < <(find "$HERE/app" -name '*.ts' -type f 2>/dev/null)
for p in "$HERE"/patches/*/*.patch; do
  [ -e "$p" ] || continue
  n="${p##*/}"; n="${n%.patch}"
  f="${n//__//}"
  case "$f" in *.ts) OWNED+=("$f");; esac
done

# Keep only those that exist in the composed tree and are host-side (the
# container tree has its own toolchain and is not prettier-managed here).
CHECK=()
for f in "${OWNED[@]}"; do
  case "$f" in src/*) [ -f "$TREE/$f" ] && CHECK+=("$f");; esac
done

if [ "${#CHECK[@]}" -eq 0 ]; then
  echo "check-format: nothing owned to check" >&2
  exit 0
fi

# Deduplicate — a file can be both app/-owned and patch-listed.
mapfile -t CHECK < <(printf '%s\n' "${CHECK[@]}" | sort -u)

cd "$TREE" || exit 2
if pnpm exec prettier --check "${CHECK[@]}" > /tmp/check-format.out 2>&1; then
  echo "format OK: ${#CHECK[@]} owned file(s) are prettier-clean"
  exit 0
fi

echo "❌ format: these files are not prettier-clean, so the composed tree's" >&2
echo "   pre-commit hook will rewrite them on the next deploy commit:" >&2
grep '^\[warn\] ' /tmp/check-format.out | sed 's/^\[warn\] /     /' >&2
echo "" >&2
echo "   Fix app/-owned files in place:" >&2
echo "     prettier --config <composed>/.prettierrc --write \"app/src/**/*.ts\"" >&2
echo "   For a patched file, format it in a composed tree and regenerate:" >&2
echo "     scripts/regen-patches.sh <composed-tree> <path>" >&2
exit 1
