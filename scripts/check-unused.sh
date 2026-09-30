#!/usr/bin/env bash
# check-unused.sh — no unused imports or locals in code we own.
#
#   scripts/check-unused.sh <composed-tree>
#
# Nothing ran eslint's unused-vars rule on our files, and 300-odd unused imports
# collected in one module before anyone noticed. Same scope as check-async.sh:
# app/ files in full, only the lines our patches add in upstream files, so an
# upstream change can never turn this red. Function parameters and caught errors
# are exempt (unused ones are routine in handlers); prefix a local with _ to keep
# it deliberately.
set -uo pipefail
CHECK_OWNED_NAME=unused \
CHECK_OWNED_RULES='{"@typescript-eslint/no-unused-vars": ["error", {"args": "none", "caughtErrors": "none", "ignoreRestSiblings": true, "varsIgnorePattern": "^_", "destructuredArrayIgnorePattern": "^_"}]}' \
CHECK_OWNED_OK='no unused imports or locals' \
CHECK_OWNED_FAIL='imported or declared, never used:' \
CHECK_OWNED_HINT='Delete it. An import kept only for its side effects is written import "./x.js".' \
  exec bash "$(dirname "$0")/check-async.sh" "$@"
