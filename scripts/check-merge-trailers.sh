#!/usr/bin/env bash
# Fail when a pushed commit carries a forge merge trailer naming the private forge.
#
#   scripts/check-merge-trailers.sh <before-sha> <after-sha>
#   scripts/check-merge-trailers.sh --selftest
#
# WHY THIS EXISTS, given leak-scan.sh already has TRAILER_RE.
#
# It does, and mode_range checks it — but the workflow computes its range as
# merge-base(origin/main, HEAD)..HEAD. On a push to main, HEAD *is* main, so that
# range is EMPTY. At PR time the merge commit does not exist yet. The one commit
# that can carry a trailer is therefore the one commit no run ever scans, and 35
# of them accumulated under a gate that looks like it guards this.
#
# The fix is to scan the range that was actually pushed — before..after — which
# is the only moment the merge commit is both new and visible.
#
# Trailers matter because they name the forge's LAN address inside a commit
# MESSAGE. No tree-level scrub reaches that once written; the only remedy is a
# history rewrite. Catching one at push time costs a re-push; catching it later
# costs rewriting every commit since.
set -uo pipefail

# Anchored to the trailer keys, and matched against RFC1918 / CGNAT ranges rather
# than one hardcoded host — a forge that moves to a different private address is
# the same leak. KEEP-IN-SYNC with TRAILER_RE in leak-scan.sh.
TRAILER_RE='^(Reviewed-on|Reviewed-by|Co-authored-by):.*(10[.]|172[.](1[6-9]|2[0-9]|3[01])[.]|192[.]168[.]|100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.])'

scan_range() { # scan_range <range> -> 0 clean, 1 found
  local range="$1" msgs hits
  msgs=$(git log --format='%H%n%B' "$range" 2>/dev/null | grep -vF 'leak-scan-allow') || true
  [ -z "$msgs" ] && return 0
  hits=$(printf '%s\n' "$msgs" | grep -inE -- "$TRAILER_RE") || true
  [ -z "$hits" ] && return 0
  echo "❌ forge merge trailer(s) naming an internal host in pushed commits:"
  printf '   %s\n' "$hits" | head -10
  echo
  echo "   These land in commit MESSAGES, which no tree scrub can reach later."
  echo "   Merge locally instead of through the web UI — see"
  echo "   .gitea/default_merge_message/README.md."
  return 1
}

if [ "${1:-}" = "--selftest" ]; then
  pass=0; fail=0
  chk() { if [ "$2" = "$3" ]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1 (want rc=$2 got rc=$3)"; fail=$((fail+1)); fi; }
  echo "merge-trailer guard self-test"
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  git init -q "$tmp/r" && cd "$tmp/r"
  git config user.email t@t; git config user.name t
  git commit -q --allow-empty -m base
  BASE=$(git rev-parse HEAD)

  git commit -q --allow-empty -m "ordinary commit with no trailer"
  chk "clean range passes" 0 "$(scan_range "$BASE..HEAD" >/dev/null 2>&1; echo $?)"

  C1=$(git rev-parse HEAD)
  git commit -q --allow-empty -m "$(printf "Merge pull request 'x' (#1)\n\nReviewed-on: http://192.168.0.2:3000/forge/r/pulls/1")"
  chk "LAN trailer is caught" 1 "$(scan_range "$C1..HEAD" >/dev/null 2>&1; echo $?)"

  # Other private ranges are the same leak — a forge that moves must still fail.
  C2=$(git rev-parse HEAD)
  git commit -q --allow-empty -m "$(printf "m\n\nReviewed-on: http://10.4.0.9:3000/x/y/pulls/2")"
  chk "other RFC1918 range is caught" 1 "$(scan_range "$C2..HEAD" >/dev/null 2>&1; echo $?)"

  # A PUBLIC url in the same trailer is not a leak and must not block.
  C3=$(git rev-parse HEAD)
  git commit -q --allow-empty -m "$(printf "m\n\nReviewed-on: https://github.com/javexed/nanoclaw-webchat/pull/3")"
  chk "public URL trailer does NOT block" 0 "$(scan_range "$C3..HEAD" >/dev/null 2>&1; echo $?)"

  # The escape hatch the rest of the repo uses, so the guard cannot be a trap.
  C4=$(git rev-parse HEAD)
  git commit -q --allow-empty -m "$(printf "m\n\nReviewed-on: http://192.168.0.2:3000/x leak-scan-allow")"
  chk "leak-scan-allow marker exempts a line" 0 "$(scan_range "$C4..HEAD" >/dev/null 2>&1; echo $?)"

  echo "  $pass passed, $fail failed"
  [ "$fail" -eq 0 ] || exit 1
  exit 0
fi

BEFORE="${1:-}"; AFTER="${2:-HEAD}"
# A zero/absent `before` is a branch creation or a force-push with no usable
# base. Scanning "everything" there would re-flag the 35 historical trailers and
# turn this into a permanently red check, so fall back to the newest commit only
# — which is still the merge commit on an ordinary push.
if [ -z "$BEFORE" ] || [ "$BEFORE" = "0000000000000000000000000000000000000000" ] \
   || ! git rev-parse --verify -q "$BEFORE^{commit}" >/dev/null 2>&1; then
  RANGE="${AFTER}~1..${AFTER}"
  git rev-parse --verify -q "${AFTER}~1" >/dev/null 2>&1 || { echo "✅ no prior commit to compare"; exit 0; }
else
  RANGE="${BEFORE}..${AFTER}"
fi

if scan_range "$RANGE"; then
  echo "✅ no internal-host merge trailers in $RANGE"
  exit 0
fi
exit 1
