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
echo "leak-gate self-test:"; bash scripts/leak-scan.sh --selftest
