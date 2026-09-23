#!/usr/bin/env bash
# Proves ci-host-test-subset.sh still selects what it should — and refuses
# what it must. Runs against throwaway fixtures, never the repo's own tree.
# A selector only ever seen to pass is not evidence: the failure that matters
# is the one where it quietly picks too little.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEL="$HERE/ci-host-test-subset.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ok   $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL $1"; }

# Fixture repo: two app/ tests, one of them under container/ (bun's scope).
REPO="$T/repo"; mkdir -p "$REPO/app/src/channels/webchat" "$REPO/app/container/agent-runner/src" "$REPO/patches"
git -C "$REPO" init -q
: > "$REPO/app/src/channels/webchat/ours.test.ts"
: > "$REPO/app/container/agent-runner/src/ours-bun.test.ts"
git -C "$REPO" add -A && git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm fixture

# Fixture composed tree: those two landed, plus upstream files and tests.
TREE="$T/tree"; mkdir -p "$TREE/src/channels/webchat" "$TREE/container/agent-runner/src" "$TREE/setup"
: > "$TREE/src/channels/webchat/ours.test.ts"
: > "$TREE/container/agent-runner/src/ours-bun.test.ts"
: > "$TREE/src/router.ts"; : > "$TREE/src/router.test.ts"; : > "$TREE/src/router.seam.test.ts"
: > "$TREE/src/router.chains.test.ts"; : > "$TREE/src/unrelated.test.ts"
: > "$TREE/container/agent-runner/src/x.ts"; : > "$TREE/container/agent-runner/src/x.test.ts"
: > "$TREE/container/top.test.ts"
: > "$TREE/setup/verify.ts"; : > "$TREE/setup/verify.test.ts"

sel() { bash "$SEL" --touched "$1" "$REPO" "$TREE" 2>/dev/null; }

# 1. a touched source file maps to its sibling tests, and to nothing else
printf 'src/router.ts\n' > "$T/t1"
out=$(sel "$T/t1")
grep -qx 'src/router.test.ts' <<<"$out"        && ok "x.ts → x.test.ts"        || bad "x.ts → x.test.ts"
grep -qx 'src/router.seam.test.ts' <<<"$out"   && ok "x.ts → dir/*.seam.test.ts" || bad "x.ts → dir/*.seam.test.ts"
grep -qx 'src/router.chains.test.ts' <<<"$out" && ok "x.ts → x.*.test.ts"      || bad "x.ts → x.*.test.ts"
grep -qx 'src/unrelated.test.ts' <<<"$out"     && bad "unrelated test leaked in" || ok "unrelated test stays out"
grep -qx 'setup/verify.test.ts' <<<"$out"      && bad "untouched setup test leaked in" || ok "untouched setup test stays out"

# 2. our own tests are always in, whatever was touched
grep -qx 'src/channels/webchat/ours.test.ts' <<<"$out" && ok "app/ test always selected" || bad "app/ test always selected"
# vitest silently drops a filter that matches no collected file, so an app/ test
# outside its include would inflate the list without running.
grep -qx 'container/agent-runner/src/ours-bun.test.ts' <<<"$out" && bad "our deep-container test leaked into the vitest list" || ok "our deep-container test stays out (bun's)"

# 3. container depth: bun's tests are not vitest's; top-level container/*.test.ts is
printf 'container/agent-runner/src/x.ts\ncontainer/top.test.ts\n' > "$T/t3"
out=$(sel "$T/t3")
grep -qx 'container/agent-runner/src/x.test.ts' <<<"$out" && bad "deep container test selected (bun scope)" || ok "deep container test excluded"
grep -qx 'container/top.test.ts' <<<"$out" && ok "top-level container test selected" || bad "top-level container test selected"

# 4. a touched test file selects itself
printf 'setup/verify.test.ts\n' > "$T/t4"
grep -qx 'setup/verify.test.ts' <<<"$(sel "$T/t4")" && ok "touched test selects itself" || bad "touched test selects itself"

# 5. refuses when one of our tests did not land in the composed tree
rm "$TREE/src/channels/webchat/ours.test.ts"
if sel "$T/t1" >/dev/null; then bad "missing app/ test must fail"; else ok "missing app/ test fails"; fi
: > "$TREE/src/channels/webchat/ours.test.ts"

# 6. refuses an empty selection
REPO2="$T/repo2"; mkdir -p "$REPO2/patches"; git -C "$REPO2" init -q
: > "$REPO2/.keep"; git -C "$REPO2" add -A && git -C "$REPO2" -c user.email=t@t -c user.name=t commit -qm empty
printf 'setup/nothing-here.ts\n' > "$T/t6"
if bash "$SEL" --touched "$T/t6" "$REPO2" "$TREE" >/dev/null 2>&1; then bad "empty selection must fail"; else ok "empty selection fails"; fi

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
