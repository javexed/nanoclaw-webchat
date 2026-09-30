#!/usr/bin/env bash
# check-setup-prompts.selftest.sh — prove check-setup-prompts.mjs still fails on
# a new upstream prompt, a new setup step, a skip an installer dropped, and an
# installer running setup:auto outside the shared list.
#
#   scripts/check-setup-prompts.selftest.sh <composed-tree>
set -uo pipefail
TREE="${1:?usage: check-setup-prompts.selftest.sh <composed-tree>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$HERE/scripts/check-setup-prompts.mjs"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0
expect() { # <want-exit> <label> <tree> [installers-root]
  local want=$1 label=$2 tree=$3 root=${4:-$HERE}
  SETUP_PROMPTS_INSTALLERS_ROOT="$root" node "$CHECK" "$tree" >"$T/out" 2>&1
  local got=$?
  if [ "$got" -ne "$want" ]; then
    echo "❌ selftest: $label — exit $got, expected $want" >&2
    cat "$T/out" >&2
    fail=1
  fi
}

expect 0 "the real tree passes" "$TREE"

# A new prompt in upstream's setup.
cp -r "$TREE/setup" "$T/prompt-tree-setup"
mkdir -p "$T/prompt/" && mv "$T/prompt-tree-setup" "$T/prompt/setup"
printf "\nexport const probe = () => p.confirm({ message: 'Selftest: a brand-new question?' });\n" >>"$T/prompt/setup/auto.ts"
expect 1 "a new prompt fails" "$T/prompt"
grep -q "brand-new question" "$T/out" || { echo "❌ selftest: the new prompt was not named" >&2; fail=1; }

# A new skippable step.
mkdir -p "$T/step" && cp -r "$TREE/setup" "$T/step/setup"
printf "\nif (!skip.has('selftest-step')) {}\n" >>"$T/step/setup/auto.ts"
expect 1 "a new step fails" "$T/step"

# An installer that no longer skips an interactive step.
mkdir -p "$T/inst/app/deploy"
sed "s/,timezone,/,/" "$HERE/app/deploy/webchat-deploy.sh" >"$T/inst/app/deploy/webchat-deploy.sh"
cp "$HERE/app/deploy/install.sh" "$T/inst/app/deploy/"
expect 1 "a dropped skip fails" "$TREE" "$T/inst"
grep -q "lacks 'timezone'" "$T/out" || { echo "❌ selftest: the dropped skip was not named" >&2; fail=1; }

# install.sh running setup:auto on its own, past the shared list.
cp "$HERE/app/deploy/webchat-deploy.sh" "$T/inst/app/deploy/"
printf '\nrun_as "NANOCLAW_SKIP=auth pnpm run setup:auto </dev/null"\n' >>"$T/inst/app/deploy/install.sh"
expect 1 "a separate setup:auto run fails" "$TREE" "$T/inst"
grep -q "runs setup:auto itself" "$T/out" || { echo "❌ selftest: the separate setup:auto run was not named" >&2; fail=1; }

[ "$fail" -eq 0 ] && echo "check-setup-prompts selftest OK: new prompt, new step, a dropped skip and a separate setup:auto run all fail"
exit "$fail"
