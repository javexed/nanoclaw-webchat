#!/usr/bin/env bash
# What does this change touch? Decides how much of the compose job a PR has
# to pay for. Prints two lines for $GITHUB_OUTPUT:
#
#   ui=true|false     run the UI phase (install, guards, Chromium, browser
#                     probes, bundle-drift) — ~5 minutes of a ~7 minute job
#   host=full|subset  run upstream's whole host suite, or only the tests that
#                     can be affected by what this repo changes (see
#                     ci-host-test-subset.sh)
#
# FAILS OPEN on purpose, same shape as the container-tree gate: a push event,
# a missing base, an unresolvable merge-base, or any error all answer "run
# everything". The only way to skip is to positively prove the diff misses
# every path that can matter. Skipping on uncertainty would trade minutes for
# the chance of landing an untested change.
#
# Usage: ci-scope.sh <event_name> <base_ref> [remote]
#   Must run inside the checkout, with network to fetch the base.
set -uo pipefail

EVENT="${1:-}"
BASE_REF="${2:-}"
REMOTE="${3:-origin}"

decide() { printf 'ui=%s\nhost=%s\n' "$1" "$2"; exit 0; }
everything() { echo "ci-scope: $1 — running everything" >&2; decide true full; }

[ "$EVENT" = "pull_request" ] || everything "event is '$EVENT', not pull_request"
[ -n "$BASE_REF" ] || everything "no base ref"
git fetch -q --depth 50 "$REMOTE" "$BASE_REF" 2>/dev/null || everything "cannot fetch base '$BASE_REF'"
BASE_SHA=$(git rev-parse FETCH_HEAD)
# The job checks out with --depth 1, so HEAD has NO ancestry: however deep the
# base is fetched, merge-base cannot be computed and the gate silently fails
# open on every PR. Deepen HEAD's own history as well. 50 on each side covers
# any PR that is not absurdly stale; a staler one still fails open.
git fetch -q --depth 50 "$REMOTE" "$(git rev-parse HEAD)" 2>/dev/null || everything "cannot deepen HEAD"
MB=$(git merge-base "$BASE_SHA" HEAD 2>/dev/null) || everything "no merge-base"
[ -n "$MB" ] || everything "empty merge-base"
CHANGED=$(git diff --name-only "$MB"..HEAD 2>/dev/null) || everything "diff failed"
[ -n "$CHANGED" ] || everything "empty diff"

# Anything that changes how the tree is COMPOSED or TESTED means the subset
# selection itself cannot be trusted: the pins, the patch residue, the
# installer, this repo's scripts (the guards and the selector live there), and
# the workflow. app/container/ is the container gate's business, but a host
# file under app/ that overwrites an upstream file is covered by the subset
# selector (it maps overwritten upstream files to their tests), so app/ alone
# does not force the full suite.
FULL_RE='^(versions\.json$|patches/|install\.sh$|scripts/|\.github/workflows/)'
# The UI phase exists to guard ui/ and the committed bundle it produces. The
# browser probes are driven by scripts/, which FULL_RE already covers.
UI_RE='^(ui/|app/public/webchat/|scripts/|\.github/workflows/)'

ui=false; host=subset
printf '%s\n' "$CHANGED" | grep -qE "$UI_RE" && ui=true
printf '%s\n' "$CHANGED" | grep -qE "$FULL_RE" && host=full

echo "ci-scope: $(printf '%s\n' "$CHANGED" | wc -l) changed path(s) since $MB → ui=$ui host=$host" >&2
decide "$ui" "$host"
