#!/usr/bin/env bash
# What does this change touch? Decides how much of the compose job a PR has
# to pay for. Prints four lines for $GITHUB_OUTPUT:
#
#   ui=true|false      run the UI phase (install, guards, Chromium, browser
#                      probes, bundle-drift)
#   host=full|subset   run upstream's whole host suite, or only the tests that
#                      can be affected by what this repo changes (see
#                      ci-host-test-subset.sh)
#   guards=true|false  run compose's guard SELF-TESTS — the steps that prove each
#                      guard still catches the fault it exists for. That proof
#                      depends on the guard (its script, probe, fixtures and
#                      baselines) and the workflow, not on product code, so a
#                      PR that touches none of those skips them. The guards
#                      themselves always run.
#   runner=true|false  apply the VS Code runner skill to the composed tree and
#                      re-check it: only when the skill, the webchat server it
#                      plugs into, or how the tree is composed changes
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

decide() { printf 'ui=%s\nhost=%s\nguards=%s\nrunner=%s\n' "$1" "$2" "$3" "$4"; exit 0; }
everything() { echo "ci-scope: $1 — running everything" >&2; decide true full true true; }

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

# Guards and their self-tests live in scripts/ and ui/ (the browser probes,
# their servers and the recorded baselines); ci/ holds their fixtures.
GUARDS_RE='^(scripts/|ui/[^/]+\.(mjs|sh|json)$|ci/|\.github/workflows/)'
RUNNER_RE='^(app/\.claude/skills/add-vscode-runner/|app/src/channels/webchat/|app/src/modules/|patches/|versions\.json$|install\.sh$|scripts/|\.github/workflows/)'

ui=false; host=subset; guards=false; runner=false
printf '%s\n' "$CHANGED" | grep -qE "$UI_RE" && ui=true
printf '%s\n' "$CHANGED" | grep -qE "$FULL_RE" && host=full
printf '%s\n' "$CHANGED" | grep -qE "$GUARDS_RE" && guards=true
printf '%s\n' "$CHANGED" | grep -qE "$RUNNER_RE" && runner=true

echo "ci-scope: $(printf '%s\n' "$CHANGED" | wc -l) changed path(s) since $MB → ui=$ui host=$host guards=$guards runner=$runner" >&2
decide "$ui" "$host" "$guards" "$runner"
