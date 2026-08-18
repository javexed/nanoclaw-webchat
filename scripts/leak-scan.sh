#!/usr/bin/env bash
# leak-scan.sh — stop internal / secret material from entering the public
# history of this repo. Runs at COMMIT time (pre-commit / pre-push hooks) and
# in CI (the required leak-gate check), replacing the old scrub-at-publish
# mirror gate now that the repo itself is the public surface.
#
#   scripts/leak-scan.sh --staged            # staged changes (pre-commit hook)
#   scripts/leak-scan.sh --range <A>..<B>    # a commit range (pre-push, CI)
#   scripts/leak-scan.sh --text <file|->     # prose bound for a PR/issue/comment
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
#   $LEAK_PATTERNS_FILE. Local hooks read a private file OUTSIDE this repo; CI injects
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

# ── GENERIC: secret-shaped fixtures that are provably synthetic ──────────────
# A redaction module needs tests, and those tests must contain secret-SHAPED
# strings to prove redaction works — so a tree-wide shape scan will always hit
# them. Enumerated exactly, never by path: exempting "*.test.ts" wholesale would
# wave through a REAL key pasted into a test, which is a realistic way secrets
# leak. Every entry below is sequential filler or a dictionary word; a genuine
# key is not on this list and still blocks. Adding one is a reviewable diff line.
#
# The self-test's own fixtures are deliberately ABSENT: they exist to prove the
# gate CATCHES secrets, so allowlisting them would silently disable the test.
# They are exempted per-line by the leak-scan-allow marker instead. Note RSA is
# listed but OPENSSH is not: RSA is a redact.test.ts fixture, OPENSSH is a
# self-test fixture.
ALLOWED_SECRET_RE='^(-----BEGIN RSA PRIVATE KEY-----|ghp_ABCDEFGHIJKLMNOPQRSTuvwx|sk-abc123DEF456ghi789|sk-ant-api03-REGRESSION-SECRET-DO-NOT-LEAK-000|sk-ant-oat-WORKSPACE|xoxb-12345-67890-abcdef|xoxb-REAL-SECRET)$'  # leak-scan-allow — this line IS the list;
# the `new` tier matches secret shapes strictly (an allowlisted token in a NEW
# commit should still be questioned), so the definition needs the same per-line
# marker the self-test fixtures use. The marker is visible in review, which is
# the whole contract.

# ── OPERATOR identifiers: injected at runtime, never stored here ──────────────
# A pattern prefixed `cs:` is matched CASE-SENSITIVELY — needed for the internal
# org path (mixed-case), which folded to lowercase matches the PUBLIC repo path
# `javexed/nanoclaw/` and would flag every legitimate GitHub URL. Everything
# else is case-insensitive (tailnet name, personal emails, the token).
# WHERE THE LIST COMES FROM, in order. `git config leakscan.patternsFile` is how
# a clone DECLARES it has a list: it is per-clone, never committed, and forks
# have it unset. The old hard-coded default stays last so existing setups keep
# working — but a path that is *declared* and then missing is an error, not a
# shrug (see require_or_warn_operator_tier).
PATTERNS_DEFAULT="$HOME/.config/nanoclaw-webchat/leak-patterns.txt"
patterns_file() {
  if [ -n "${LEAK_PATTERNS_FILE:-}" ]; then printf '%s' "$LEAK_PATTERNS_FILE"; return; fi
  local cfg; cfg=$(git config --get leakscan.patternsFile 2>/dev/null || true)
  [ -n "$cfg" ] && { printf '%s' "$cfg"; return; }
  printf '%s' "$PATTERNS_DEFAULT"
}
# Did someone explicitly say this clone has a list? Declaring it is what turns a
# missing list from "probably a fork" into "your gate is broken".
tier_declared() {
  [ "${LEAK_REQUIRE_OPERATOR_TIER:-0}" = 1 ] && return 0
  [ -n "${LEAK_PATTERNS_FILE:-}" ] && return 0
  [ -n "$(git config --get leakscan.patternsFile 2>/dev/null || true)" ] && return 0
  return 1
}
operator_lines() {
  local f; f=$(patterns_file)
  { [ -f "$f" ] && cat "$f"
    [ -n "${LEAK_PATTERNS:-}" ] && printf '%s\n' "$LEAK_PATTERNS"; } 2>/dev/null \
    | grep -vE '^[[:space:]]*(#|$)'
}
operator_regex_ci() { operator_lines | grep -v '^cs:' | paste -sd'|' - || true; }
operator_regex_cs() { operator_lines | grep '^cs:' | sed 's/^cs://' | paste -sd'|' - || true; }

OPERATOR_TIER=off   # reported by finish(), so "clean" always says what ran

# A silently-absent operator tier is its own failure mode: with no patterns
# loaded, operator_regex_ci() is empty, and match() returns 0 on an empty
# regex — so the identifier tier disappears without a word and the gate still
# reports green.
#
# Forks legitimately have no list (see the header), so an UNDECLARED absence
# stays a warning. But when a clone has declared one — via `git config
# leakscan.patternsFile`, $LEAK_PATTERNS_FILE, or $LEAK_REQUIRE_OPERATOR_TIER=1
# on a trusted CI run — an empty list means the file moved, the secret was
# renamed, or the path was wrong, and the run must FAIL rather than report a
# green that covers half the gate.
#
# This is not hypothetical (2026-08-17): the hooks looked for the list under
# ~/.config while the operator's real file lived elsewhere, so the identifier
# tier would have been off on the operator's own machine — the one place it is
# mandatory — with nothing but a stderr warning to say so.
require_or_warn_operator_tier() {
  if [ -n "$(operator_lines)" ]; then OPERATOR_TIER=on; return 0; fi
  if tier_declared; then
    say "❌ operator identifier tier is DECLARED but no patterns loaded — failing closed."
    say "   looked for: $(patterns_file)"
    say "   a declared list that does not load means the gate is half off; fix the path"
    say "   (git config leakscan.patternsFile <path>) or unset the declaration deliberately."
    fail=1; return 1
  fi
  printf '\033[1;33m[leak-scan] WARNING: no operator identifier patterns loaded.\033[0m\n' >&2
  printf '  Running the GENERIC tier only (secret shapes + address hygiene).\n' >&2
  printf '  Set $LEAK_PATTERNS_FILE, $LEAK_PATTERNS, or git config leakscan.patternsFile\n' >&2
  printf '  to enable the identifier tier.\n' >&2
}

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
#   tree (whole checkout) — private addresses, plus secret shapes checked
#        against an ENUMERATED fixture allowlist. Operator identifiers stay
#        GRANDFATHERED tree-wide: real project names are used as seed data
#        throughout, a tree-wide grep for them is false positives on content
#        that refusing today's commit cannot fix, and a gate that cries wolf on
#        untouchable content is a gate people learn to bypass.
#        Secret shapes no longer need that amnesty. The tree contains exactly
#        seven secret-shaped tokens and all seven are enumerated fixtures, so
#        the scan is silent today and any EIGHTH — however it arrives — blocks.
#        Addresses stay tree-wide for the same reason: the tree is verifiably
#        clean, so the check costs nothing and catches anything arriving
#        out-of-band (a force-push, an imported root commit).
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
  # Secret hygiene (tree only — `new` is covered by the strict match above, and
  # running both would report the same token twice). Mirrors the address check
  # below: every secret-shaped string present must be a known synthetic fixture.
  # Reported as bare tokens rather than whole lines so a genuine hit is not
  # echoed with its surrounding context.
  if [ "$mode" = tree ]; then
    local tok badtok=""
    while IFS= read -r tok; do
      [ -z "$tok" ] && continue
      printf '%s' "$tok" | grep -qE -- "$ALLOWED_SECRET_RE" || badtok="$badtok$tok"$'\n'
    done < <(printf '%s\n' "$text" | grep -oiE -- "$SECRET_RE" 2>/dev/null | sort -u)
    if [ -n "$badtok" ]; then
      say "❌ secret-shaped strings not on the fixture allowlist ($label) — add a line to leak-scan.sh, or use a synthetic value:"
      printf '     %s\n' $badtok; fail=1
    fi
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

# Always name the tiers that ran. A bare "clean" is what let a generic-only run
# read as a full pass while the identifier tier was silently off.
finish() {
  local tiers="generic"
  [ "$OPERATOR_TIER" = on ] && tiers="generic + operator-identifiers"
  if [ "$fail" -ne 0 ]; then say "leak gate BLOCKED — fix the above, do not commit/push."; exit 1; fi
  say "✅ leak gate clean ($tiers)"
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
  # TREE checks — operator identifiers, private addresses, and secret shapes
  # against the fixture allowlist. The allowlist needs a case in BOTH directions
  # or it is just an untested hole: an enumerated fixture must pass, and a token
  # one character off it must still block.
  s_clean(){ :; }
  s_lan(){ echo 'http://192.168.5.90:11434'>"$1/c.ts"; }  # leak-scan-allow
  s_op(){ echo 'host acme-forge.acme-tailnet.internal'>"$1/d.md"; }
  s_allowed(){ echo 'H="192.168.0.2"; D="172.17.0.1";'>"$1/f.ts"; }  # leak-scan-allow
  echo "leak-scan self-test"
  check "clean tree passes"                    0 s_clean
  check "unlisted private LAN caught"          1 s_lan
  check "operator id NOT tree-flagged (grandfathered)" 0 s_op
  check "allowlisted addresses pass"           0 s_allowed
  s_allowed_secret(){ echo "k='sk-ant-oat-WORKSPACE'">"$1/w.ts"; }  # leak-scan-allow
  s_nearmiss(){ echo "k='sk-ant-oat-WORKSPACF'">"$1/n.ts"; }  # leak-scan-allow
  check "allowlisted secret fixture passes"    0 s_allowed_secret
  check "near-miss of an allowlisted token blocks" 1 s_nearmiss

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

  # DECLARED-BUT-ABSENT tier. The whole point of the 2026-08-17 change: a clone
  # that says it has an identifier list must fail when the list does not load,
  # while a fork that says nothing keeps passing on the generic tier alone.
  tier_case() { # <name> <want-fail 0|1> <env-setup...>
    local name="$1" want="$2"; shift 2
    ( cd "$gt"; unset LEAK_PATTERNS LEAK_PATTERNS_FILE LEAK_REQUIRE_OPERATOR_TIER
      "$@"
      fail=0; OPERATOR_TIER=off
      require_or_warn_operator_tier >/dev/null 2>&1
      [ "$fail" -eq "$want" ] )
    if [ $? -eq 0 ]; then echo "  ok   $name"; pass=$((pass+1)); else echo "  FAIL $name"; tf=$((tf+1)); fi
  }
  d_none() { :; }                                            # fork: nothing declared
  d_env_missing()  { export LEAK_PATTERNS_FILE="$tmp/nope.txt"; }
  d_flag_missing() { export LEAK_REQUIRE_OPERATOR_TIER=1; }
  d_env_present()  { printf 'acme-tailnet\n' > "$tmp/p.txt"; export LEAK_PATTERNS_FILE="$tmp/p.txt"; }
  tier_case "undeclared + absent warns, does not block" 0 d_none
  tier_case "declared file MISSING fails closed"        1 d_env_missing
  tier_case "required flag + no list fails closed"      1 d_flag_missing
  tier_case "declared file present passes"              0 d_env_present

  echo "  $pass passed, $tf failed"
  [ "$tf" -eq 0 ]
}

# Scan arbitrary prose — a PR body, an issue, a review comment, release notes —
# BEFORE it is posted. Added 2026-08-10 after an internal reference reached a
# public PR comment: every mode above scans FILES and COMMIT MESSAGES, and a
# comment box is neither. Text posted to a public forge is exactly as public as
# a committed line and had no gate on it at all. Reads a file, or stdin with `-`.
mode_text() {
  local src="${1:--}" text
  if [ "$src" = - ]; then text=$(cat); else
    [ -f "$src" ] || { echo "leak-scan: no such file: $src" >&2; exit 2; }
    text=$(cat -- "$src")
  fi
  scan_content "$text" "${2:-text}" new
}

case "${1:-}" in
  --staged)   require_or_warn_operator_tier; mode_staged; finish ;;
  --range)    require_or_warn_operator_tier; mode_range "${2:?range required}"; finish ;;
  --text)     require_or_warn_operator_tier; mode_text "${2:--}"; finish ;;
  # --tree does NOT consult the operator tier at all (identifiers are
  # grandfathered tree-wide, see scan_content), so requiring a list here would
  # fail runs for a check that would not have used it.
  --tree)     mode_tree "${2:?dir required}"; finish ;;
  --selftest) selftest ;;
  *) echo "usage: leak-scan.sh --staged | --range <A..B> | --text <file|-> | --tree <dir> | --selftest" >&2; exit 2 ;;
esac
