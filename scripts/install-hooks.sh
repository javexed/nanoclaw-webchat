#!/usr/bin/env bash
# install-hooks.sh — point this clone at the tracked hooks (leak gate +
# freshness preflight). Run once per machine; git hooks are not cloned.
#
#   scripts/install-hooks.sh
#
# Supersedes the old manual `ln -sf ../../app/scripts/pre-push-preflight.sh
# .git/hooks/pre-push` — the hooks are now version-controlled in .githooks/ and
# one config command wires them, so both gates stay in step across machines.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "core.hooksPath → .githooks (pre-commit + pre-push active)"

# Point this clone at the operator identifier list, if there is one. Declaring it
# is what makes a LATER disappearance an error instead of a silent downgrade to
# the generic tier — see require_or_warn_operator_tier in leak-scan.sh. Nothing
# is declared for a contributor who has no list, which is the correct fork shape.
if [ -n "${LEAK_PATTERNS_FILE:-}" ] && [ -f "${LEAK_PATTERNS_FILE}" ]; then
  git config leakscan.patternsFile "$LEAK_PATTERNS_FILE"
  echo "leakscan.patternsFile → $LEAK_PATTERNS_FILE (identifier tier required)"
elif [ -n "$(git config --get leakscan.patternsFile || true)" ]; then
  echo "leakscan.patternsFile → $(git config --get leakscan.patternsFile) (already set)"
else
  echo
  echo "NOTE: no operator identifier list is declared for this clone, so the leak"
  echo "      gate runs its GENERIC tier only (secret shapes + address hygiene)."
  echo "      That is correct for an outside contributor. If you DO have a list:"
  echo
  echo "        git config leakscan.patternsFile /path/to/leak-patterns.txt"
  echo
  echo "      Once declared, a missing list fails the gate instead of downgrading it."
fi

echo "leak-gate self-test:"; bash scripts/leak-scan.sh --selftest
