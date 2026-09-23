#!/usr/bin/env bash
# Run the composed tree's host suite, and check vitest ran what it was told to.
#
# vitest takes file paths as FILTERS, not as a file list: one that matches no
# collected file is dropped in silence, and the run reports green having tested
# less than it was asked to. A subset that quietly shrinks is indistinguishable
# from a subset that works, so state the expected count and verify it.
#
# Usage: ci-run-host-tests.sh <log> [subset-file]
#   cwd must be the composed tree.
set -uo pipefail

LOG="${1:?log path}"
SUBSET="${2:-}"

VITEST=(pnpm exec vitest run --testTimeout=30000 --hookTimeout=30000)

: > "$LOG"
status=0

run() { # run <expected-files> <label> <files...>
  local expect="$1" label="$2"; shift 2
  local out; out=$(mktemp)
  echo "::group::host tests — $label"
  "${VITEST[@]}" "$@" 2>&1 | tee -a "$LOG" | tee "$out"
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || status=$rc
  echo "::endgroup::"
  if [ "$expect" -ge 0 ]; then
    # "Test Files  12 passed | 1 failed (13)" → the parenthesised total.
    local ran
    ran=$(sed 's/\x1b\[[0-9;]*m//g' "$out" | sed -n 's/.*Test Files .*(\([0-9]\+\))$/\1/p' | tail -1)
    if [ -n "$ran" ] && [ "$ran" -ne "$expect" ]; then
      echo "::error::Asked vitest for $expect file(s) but it collected $ran — a path in the list matches no test file vitest would run. Fix the selector; a silently smaller run is not a pass."
      status=1
    fi
  fi
  rm -f "$out"
  return 0
}

if [ -n "$SUBSET" ]; then
  mapfile -t files < <(sed '/^$/d' "$SUBSET")
  [ "${#files[@]}" -gt 0 ] && run "${#files[@]}" "subset (${#files[@]} files)" "${files[@]}"
else
  run -1 "full suite"
fi

exit "$status"
