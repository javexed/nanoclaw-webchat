#!/usr/bin/env bash
# ci-redact.selftest.sh — proves ci-redact.py still masks what the public PR
# comment must never carry, and leaves ordinary test output alone.
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)/ci-redact.py"
fail() { echo "ci-redact self-test FAILED: $1" >&2; exit 1; }

out="$(printf 'expected header "x-y-z-secret-value" to equal ""' | FORGE_TOKEN=x-y-z-secret-value python3 "$R" FORGE_TOKEN)"
case "$out" in *x-y-z-secret-value*) fail "the job's own token survived";; esac

# Token-shaped fixtures are assembled at run time so the source never holds one.
gh_fixture="ghp_$(printf 'a%.0s' $(seq 28))"
out="$(printf 'auth: Bearer abcdef0123456789xyz\nkey %s\nproxy aoc_tok12345678\n' "$gh_fixture" | python3 "$R")"
for leak in abcdef0123456789xyz "$gh_fixture" aoc_tok12345678; do
  case "$out" in *"$leak"*) fail "token-shaped string survived: $leak";; esac
done

text=' FAIL  src/x.test.ts > adds two numbers
AssertionError: expected 3 to be 4'
[ "$(printf '%s' "$text" | python3 "$R")" = "$text" ] || fail "ordinary output was changed"
echo "ci-redact self-test passed"
