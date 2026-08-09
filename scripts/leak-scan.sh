#!/usr/bin/env bash
# leak-scan.sh — stop internal / secret material from entering the public
# history of this repo. Runs at COMMIT time (pre-commit / pre-push hooks) and
# in CI (the required leak-gate check), replacing the old scrub-at-publish
# mirror gate now that the repo itself is the public surface.
#
#   scripts/leak-scan.sh --staged            # staged changes (pre-commit hook)
#   scripts/leak-scan.sh --range <A>..<B>    # a commit range (pre-push, CI)
#   scripts/leak-scan.sh --tree <dir>        # a working tree
#   scripts/leak-scan.sh --selftest          # prove the gate still detects faults
#
# TWO TIERS, because the denylist is itself sensitive:
#
#   GENERIC (in this file — safe to be public): universal secret shapes and
#   private-address hygiene. Nothing here names the operator or their infra, so
#   it ships in the repo and runs on EVERY pull request, forks included.
#
#   OPERATOR IDENTIFIERS (never in this file): the tailnet name, the private
#   forge host, personal emails, the internal org path, specific LAN subnets.
#   Listing them here would leak the very things they guard, so they arrive at
#   runtime as extra regexes via $LEAK_PATTERNS (newline-separated) or
#   $LEAK_PATTERNS_FILE. Local hooks source them from nanoclaw-ops; CI injects
#   them from an Actions secret on trusted (non-fork) runs. Absent, the generic
#   tier still runs — an outside contributor cannot leak identifiers they do
#   not know, so the identifier tier's real job is guarding the operator's OWN
#   commits, which the local hooks always have the list for.
#
# FAIL CLOSED: a scanner that passes when it errored is worse than none (found
# 2026-08-09: `grep` was ugrep, which errors on `\+` where GNU grep warns, so
# the extraction silently returned nothing and the gate passed a planted leak).
# Every match returns 0=hit / 1=clean / >=2=error, and BOTH hit and error block.
# GATE, do not advise: callers MUST branch on the exit code — a scan chained to
# a push on one `&&` line gates nothing.
set -uo pipefail

# ── GENERIC: secret-shaped strings. Universal token/key formats. ─────────────
SECRET_RE='sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}[.][A-Za-z0-9_-]{20,}[.][A-Za-z0-9_-]{10,}'

# ── GENERIC: forge/CI merge trailers carrying a private-IP instance URL ───────
TRAILER_RE='^(Reviewed-on|Reviewed-by|Co-authored-by):.*(10[.]|172[.](1[6-9]|2[0-9]|3[01])[.]|192[.]168[.]|100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.])'

# ── GENERIC: private addresses must be on the allowlist (synthetic/functional) ─
# KEEP-IN-SYNC with check-public-tree.sh's allowlist (the mirror gate this succeeds).
ALLOWED_ADDR_RE='^(127[.]0[.]0[.]1|0[.]0[.]0[.]0|172[.]17[.]0[.]1|172[.]17[.]0[.]0|172[.]16[.]0[.]0|10[.]0[.]0[.]0|192[.]168[.]0[.]0|100[.]64[.]0[.]0|10[.]0[.][0-9]+[.][0-9]+|10[.]4[.]0[.][0-9]+|192[.]168[.]0[.][0-9]+|100[.]96[.][0-9]+[.][0-9]+|100[.]1[.]2[.]3|100[.]100[.]100[.]200)$'
PRIVATE_ADDR_RE='(10[.][0-9]+[.][0-9]+[.][0-9]+|172[.](1[6-9]|2[0-9]|3[01])[.][0-9]+[.][0-9]+|192[.]168[.][0-9]+[.][0-9]+|100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.][0-9]+[.][0-9]+)'

# ── OPERATOR identifiers: injected at runtime, never stored here ──────────────
# A pattern prefixed `cs:` is matched CASE-SENSITIVELY — needed for the internal
# org path (mixed-case), which folded to lowercase matches the PUBLIC repo path
# `javexed/nanoclaw/` and would flag every legitimate GitHub URL. Everything
# else is case-insensitive (tailnet name, personal emails, the token).
operator_lines() {
  { [ -n "${LEAK_PATTERNS_FILE:-}" ] && [ -f "$LEAK_PATTERNS_FILE" ] && cat "$LEAK_PATTERNS_FILE"
    [ -n "${LEAK_PATTERNS:-}" ] && printf '%s\n' "$LEAK_PATTERNS"; } 2>/dev/null \
    | grep -vE '^[[:space:]]*(#|$)'
}
operator_regex_ci() { operator_lines | grep -v '^cs:' | paste -sd'|' - || true; }
operator_regex_cs() { operator_lines | grep '^cs:' | sed 's/^cs://' | paste -sd'|' - || true; }

fail=0
say() { printf '  %s\n' "$*"; }

# match <regex> <text> <case-flag i|I> <label> — 0 hit / 1 clean / >=2 error.
# Both a hit AND a scanner error set fail=1 (fail closed).
match() {
  local re="$1" text="$2" ci="$3" label="$4" out rc
  [ -n "$re" ] || return 0                          # empty operator regex → skip cleanly
  if [ "$ci" = i ]; then out=$(printf '%s\n' "$text" | grep -inE -- "$re"); rc=$?
  else out=$(printf '%s\n' "$text" | grep -nE -- "$re"); rc=$?; fi
  if [ "$rc" -eq 0 ]; then say "❌ $label:"; printf '     %s\n' "$out" | head -20; fail=1
  elif [ "$rc" -ge 2 ]; then say "❌ scanner ERROR on '$label' (grep rc=$rc) — failing closed"; fail=1; fi
}

# Extract added-diff lines WITHOUT regex on the marker (ugrep/GNU-agnostic).
added_lines() { awk '{ if (substr($0,1,3)=="+++") next; if (substr($0,1,1)=="+") print substr($0,2) }'; }

# A line containing the marker `leak-scan-allow` is an intentional example
# (a test fixture, a docs sample token) and is exempt — the marker is visible in
# review, the same contract as gitleaks:allow / nosec. Stripped before matching.
drop_allowed() { grep -vF -- 'leak-scan-allow' || true; }

# scan_content <text> <label> <mode:new|tree>
#
#   new  (staged / range) — everything: secret shapes, operator identifiers,
#        private addresses. This is the gate that matters, because it sees what
#        a commit ADDS. Nothing new gets through it.
#
#   tree (whole checkout) — private addresses only. Secret shapes AND operator
#        identifiers are deliberately GRANDFATHERED tree-wide, because both
#        appear legitimately in long-standing test fixtures: fake tokens
#        (sk-ant-…-DO-NOT-LEAK) and real project names used as seed data. A
#        tree-wide grep for those is false positives on content that predates
#        the gate and that refusing today's commit cannot fix — and a gate that
#        cries wolf on untouchable content is a gate people learn to bypass.
#        Addresses stay tree-wide: the tree is verifiably clean of them, so the
#        check costs nothing and catches anything that arrives out-of-band
#        (a force-push, an imported root commit).
#
# Coverage is therefore: everything NEW is fully gated; the historical tree is
# gated for addresses. GitHub's native secret scanning covers tree-wide tokens.
scan_content() {  # <text> <label> <mode:new|tree>
  local text; text=$(printf '%s\n' "$1" | drop_allowed) label="$2" mode="${3:-new}"
  if [ "$mode" = new ]; then
    match "$SECRET_RE" "$text" I "secret-shaped strings in $label"
    match "$(operator_regex_ci)" "$text" i "operator identifiers in $label"
    match "$(operator_regex_cs)" "$text" I "operator org path (case-sensitive) in $label"
  fi
  # Address hygiene: every private address present must be on the allowlist.
  local addr bad=""
  while IFS= read -r addr; do
    [ -z "$addr" ] && continue
    printf '%s' "$addr" | grep -qE -- "$ALLOWED_ADDR_RE" || bad="$bad$addr"$'\n'
  done < <(printf '%s\n' "$text" | grep -oE -- "$PRIVATE_ADDR_RE" 2>/dev/null | sort -u)
  if [ -n "$bad" ]; then
    say "❌ private addresses not on the allowlist ($label) — add a line to leak-scan.sh, or use a synthetic value:"
    printf '     %s\n' $bad; fail=1
  fi
}

mode_staged() { scan_content "$(git diff --cached --no-color | added_lines)" "staged changes" new; }

mode_range() {
  local range="$1"
  scan_content "$(git diff --no-color "$range" | added_lines)" "range $range" new
  local msgs; msgs=$(git log --format='%H %B' "$range" 2>/dev/null | drop_allowed)
  match "$TRAILER_RE" "$msgs" i "forge merge trailers with an internal instance URL"
  match "$(operator_regex_ci)" "$msgs" i "operator identifiers in commit messages"
  match "$(operator_regex_cs)" "$msgs" I "operator org path (case-sensitive) in commit messages"
}

mode_tree() {
  local dir="$1"; [ -d "$dir" ] || { echo "not a directory: $dir" >&2; exit 2; }
  scan_content "$(grep -rhI "" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist "$dir" 2>/dev/null)" "tree $dir" tree
}

finish() {
  if [ "$fail" -ne 0 ]; then say "leak gate BLOCKED — fix the above, do not commit/push."; exit 1; fi
  say "✅ leak gate clean"
}

# ── self-test: exercises staged + range + tree, since the fail-open was in a ──
# path the tree-only test never touched. A guard only seen to pass is no guard.
selftest() {
  local tmp pass=0 tf=0
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  # SYNTHETIC operator patterns — never the real identifiers, which must not ship
  # in a public file even on an exempt line.
  export LEAK_PATTERNS=$'acme-tailnet\nacme-forge[.]internal\noperator@example[.]test'
  run_tree() { ( fail=0; mode_tree "$1" >/dev/null 2>&1; [ "$fail" -eq 0 ] ); }
  check() { rm -rf "$tmp/t"; mkdir -p "$tmp/t"
    printf 'clean\nhttp://127.0.0.1:11434\n172.17.0.1\nufw allow from 172.17.0.0/16\n' > "$tmp/t/ok.txt"
    "$3" "$tmp/t"; run_tree "$tmp/t"; local rc=$?
    if [ "$rc" -eq "$2" ]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1 (rc=$rc want $2)"; tf=$((tf+1)); fi
  }
  # TREE checks — operator identifiers + private addresses (what must NEVER be
  # present). Secret shapes are NOT tree-scanned (grandfathered fixtures), so
  # they're asserted on the staged path below.
  s_clean(){ :; }
  s_lan(){ echo 'http://192.168.5.90:11434'>"$1/c.ts"; }  # leak-scan-allow
  s_op(){ echo 'host acme-forge.acme-tailnet.internal'>"$1/d.md"; }
  s_allowed(){ echo 'H="192.168.0.2"; D="172.17.0.1";'>"$1/f.ts"; }  # leak-scan-allow
  echo "leak-scan self-test"
  check "clean tree passes"                    0 s_clean
  check "unlisted private LAN caught"          1 s_lan
  check "operator id NOT tree-flagged (grandfathered)" 0 s_op
  check "allowlisted addresses pass"           0 s_allowed

  # STAGED/RANGE checks in a throwaway git repo — the paths that fail-opened
  # before, and where secret shapes ARE scanned (new additions).
  local gt="$tmp/g"; mkdir -p "$gt"
  staged_blocks() { # <name> <file-content>
    ( cd "$gt"; rm -f probe.ts; printf '%s\n' "$2" > probe.ts; git add probe.ts 2>/dev/null
      fail=0; mode_staged >/dev/null 2>&1; git reset -q probe.ts 2>/dev/null; rm -f probe.ts; [ "$fail" -ne 0 ] )
    if [ $? -eq 0 ]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1"; tf=$((tf+1)); fi
  }
  ( cd "$gt"; git init -q; git config user.email a@b.c; git config user.name t; echo clean > f.txt; git add f.txt; git commit -qm init )
  staged_blocks "sk-ant secret (staged) blocks"  'k="sk-ant-abcdef0123456789ABCDEF"'  # leak-scan-allow
  staged_blocks "ghp_ token (staged) blocks"     'ghp_0123456789abcdef0123456789abcdefABCD'  # leak-scan-allow
  staged_blocks "PEM (staged) blocks"            '-----BEGIN OPENSSH PRIVATE KEY-----'  # leak-scan-allow
  staged_blocks "AWS key (staged) blocks"        'AKIA1234567890ABCDEF'  # leak-scan-allow
  staged_blocks "operator id (staged) blocks"    'host acme-tailnet.example.net'
  ( cd "$gt" && git add . 2>/dev/null; git commit -qm x --no-verify >/dev/null 2>&1 || true
    printf 'ghp_0123456789abcdef0123456789abcdefABCD\n' > r.ts; git add r.ts; git commit -qm leak --no-verify  # leak-scan-allow
    fail=0; mode_range HEAD~1..HEAD >/dev/null 2>&1; [ "$fail" -ne 0 ] ) \
    && { echo "  ok   range secret blocks"; pass=$((pass+1)); } || { echo "  FAIL range secret blocks"; tf=$((tf+1)); }
  echo "  $pass passed, $tf failed"
  [ "$tf" -eq 0 ]
}

case "${1:-}" in
  --staged)   mode_staged; finish ;;
  --range)    mode_range "${2:?range required}"; finish ;;
  --tree)     mode_tree "${2:?dir required}"; finish ;;
  --selftest) selftest ;;
  *) echo "usage: leak-scan.sh --staged | --range <A..B> | --tree <dir> | --selftest" >&2; exit 2 ;;
esac
