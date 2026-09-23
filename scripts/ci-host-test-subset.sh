#!/usr/bin/env bash
# The host tests a PR can actually affect, as a vitest file list.
#
# Two thirds of the composed host suite is upstream's, already run by upstream
# at the pinned ref. What this repo can break is narrower:
#
#   1. its own tests — every *.test.ts under app/, which land in the composed
#      tree with the app/ prefix stripped;
#   2. upstream tests for the files this repo CHANGES in upstream's tree: the
#      seam's insertion points, every file a patch touches, and any app/ file
#      that overwrites a file upstream also ships.
#
# A changed file maps to its sibling tests by name — `x.ts` → `x.test.ts`,
# `x.*.test.ts`, and the directory's `*.seam.test.ts` — filtered to what
# vitest's include actually runs (src/, setup/, scripts/, and top-level
# container/*.test.ts). Deeper container tests are bun's and diff-gated
# separately. The mapping is deliberately by name, not by import graph: it is
# cheap, needs no tooling in the composed tree, and errs toward running more.
#
# It REFUSES to select silently: an empty list, or any app/ test missing from
# the composed tree, is an error. A selector that quietly picks nothing is
# worse than no selector — it looks like coverage.
#
# Usage: ci-host-test-subset.sh <repo> <composed-tree>
#        ci-host-test-subset.sh --touched <list-file> <repo> <composed-tree>
#   --touched supplies the changed-upstream-path list instead of deriving it
#   (the self-test uses it; production never does).
set -euo pipefail

TOUCHED_FILE=""
if [ "${1:-}" = "--touched" ]; then TOUCHED_FILE="$2"; shift 2; fi
REPO="${1:?repo dir}"
TREE="${2:?composed tree}"

jsonval() { python3 -c "import json,sys;d=json.load(open('$REPO/versions.json'));print(d$1)"; }

# vitest include, from the composed tree's config: src/setup/scripts at any
# depth, container only at the top level.
in_vitest_scope() {
  case "$1" in
    src/*.test.ts|setup/*.test.ts|scripts/*.test.ts) return 0 ;;
    container/*/*) return 1 ;;
    container/*.test.ts) return 0 ;;
    *) return 1 ;;
  esac
}

# ── 1. our own tests ─────────────────────────────────────────────────────────
# Only the ones vitest actually runs. app/ also carries deep container tests
# (bun's, run by the container step) and skill-payload tests under .claude/,
# which are outside vitest's include: listing them here would be silent, because
# vitest treats these paths as FILTERS and simply drops one that matches no
# collected file — the list would claim more coverage than the run delivers.
all_ours=$(git -C "$REPO" ls-files 'app/**/*.test.ts' 'app/*.test.ts' | sed 's#^app/##' | sort -u)
ours=""
while read -r f; do
  [ -n "$f" ] || continue
  in_vitest_scope "$f" && ours+="$f"$'\n'
done <<<"$all_ours"
ours=$(printf '%s' "$ours" | sed '/^$/d')
missing=0
while read -r f; do
  [ -n "$f" ] || continue
  [ -e "$TREE/$f" ] || { echo "ci-host-test-subset: app/$f is not in the composed tree" >&2; missing=$((missing+1)); }
done <<<"$ours"
[ "$missing" -eq 0 ] || { echo "ERROR: $missing of this repo's test files did not land in the composed tree — refusing to select a subset" >&2; exit 1; }

# ── 2. upstream files this repo changes ──────────────────────────────────────
if [ -n "$TOUCHED_FILE" ]; then
  touched=$(sort -u "$TOUCHED_FILE")
else
  UP=$(jsonval "['nanoclaw']['upstreamRef']")
  SEAM=$(jsonval "['nanoclaw']['seamH5Ref']")
  seam_files=$(git -C "$TREE" diff --name-only "$UP" "$SEAM")
  patched=$(find "$REPO/patches" -name '*.patch' -exec sed -n 's#^+++ b/##p' {} + )
  # app/ files that overwrite something upstream ships at the pin.
  overwrites=$(comm -12 \
    <(git -C "$REPO" ls-files 'app/**' | sed 's#^app/##' | sort -u) \
    <(git -C "$TREE" ls-tree -r --name-only "$UP" | sort -u))
  touched=$(printf '%s\n%s\n%s\n' "$seam_files" "$patched" "$overwrites" | sed '/^$/d' | sort -u)
fi

# The sibling globs must expand against the COMPOSED tree, so map from inside it.
mapped=$(cd "$TREE" && while read -r p; do
  [ -n "$p" ] || continue
  dir=$(dirname "$p"); base=$(basename "$p")
  if [[ "$base" == *.test.ts ]]; then
    cands="$p"
  else
    stem="${base%.ts}"
    # An unmatched glob stays literal (contains '*') and fails the -e test below.
    cands=$(printf '%s\n' "$dir/$stem.test.ts" "$dir/$stem".*.test.ts "$dir"/*.seam.test.ts)
  fi
  while read -r c; do
    [ -n "$c" ] || continue
    c="${c#./}"
    [ -e "$c" ] || continue
    in_vitest_scope "$c" || continue
    printf '%s\n' "$c"
  done <<<"$cands"
done <<<"$touched")

# ── result ───────────────────────────────────────────────────────────────────
list=$(printf '%s\n%s\n' "$ours" "$mapped" | sed '/^$/d' | sort -u)
n=$(printf '%s\n' "$list" | sed '/^$/d' | wc -l)
[ "$n" -gt 0 ] || { echo "ERROR: selected zero test files — refusing" >&2; exit 1; }
n_ours=$(printf '%s\n' "$ours" | sed '/^$/d' | wc -l)
n_all=$(printf '%s\n' "$all_ours" | sed '/^$/d' | wc -l)
echo "ci-host-test-subset: $n test file(s) — $n_ours from app/ ($((n_all - n_ours)) more are bun's or outside vitest's include), $((n - n_ours)) upstream tests for $(printf '%s\n' "$touched" | sed '/^$/d' | wc -l) changed upstream path(s)" >&2
printf '%s\n' "$list"
