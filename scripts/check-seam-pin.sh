#!/usr/bin/env bash
# check-seam-pin.sh — is versions.json's seamRef fetchable from the seam repo?
#
#   scripts/check-seam-pin.sh              # the repo CI uses (see below)
#   scripts/check-seam-pin.sh <repo-url>   # a specific repo
#
# A pin committed before its seam is published breaks every compose — CI
# found out five minutes in, as "could not be fetched". This answers in
# seconds and says what to do. Run first in CI and by the pre-push hook when a
# push changes the pin.
#
# Which repo: the argument, else NANOCLAW_WEBCHAT_SEAM_REPO (CI sets it from
# the NANOCLAW_SEAM_REPO repository variable), else `git config
# webchat.seamRepo`, else versions.json's seamRepo.
#
# NANOCLAW_SEAM_PIN overrides the pin itself (the pre-push hook checks the
# pin in the commit being pushed, not the working tree's).
#
# Found = a branch or tag of that repo contains the commit, or the server
# hands it out by SHA. EXIT: 0 found · 1 not found · 2 could not check.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
jsonval() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['nanoclaw'][sys.argv[2]])" "$ROOT/versions.json" "$1"; }

REF="${NANOCLAW_SEAM_PIN:-$(jsonval seamRef)}" || { echo "check-seam-pin: cannot read seamRef from versions.json" >&2; exit 2; }
REPO="${1:-${NANOCLAW_WEBCHAT_SEAM_REPO:-$(git -C "$ROOT" config --get webchat.seamRepo || jsonval seamRepo)}}"
SHORT="${REF:0:12}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git init -q --bare "$TMP/r"
g() { GIT_TERMINAL_PROMPT=0 git -C "$TMP/r" -c credential.helper= "$@"; }

refs="$(g ls-remote "$REPO" 2>&1)" || { echo "check-seam-pin: cannot reach $REPO: $refs" >&2; exit 2; }
found=""
if printf '%s\n' "$refs" | awk '{print $1}' | grep -qx "$REF"; then
  found="a branch or tag tip"
elif g fetch -q --filter=blob:none "$REPO" "+refs/heads/*:refs/heads/*" "+refs/tags/*:refs/tags/*" 2>/dev/null \
  && g cat-file -e "$REF^{commit}" 2>/dev/null; then
  found="the history of a branch or tag"
elif g fetch -q --depth=1 "$REPO" "$REF" 2>/dev/null; then
  found="a fetch by SHA"
fi

if [ -n "$found" ]; then
  echo "seam pin OK: $SHORT is on $REPO ($found)"
  exit 0
fi
cat >&2 <<EOF
❌ seam pin $SHORT is not on $REPO — no branch or tag holds it, and the
   server won't hand it out by SHA. Every compose of this tree will fail.

   Publish the seam first. A tag needs no force-push:
     git tag seam/$(date -u +%Y-%m-%d) $REF && git push <remote> seam/$(date -u +%Y-%m-%d)
EOF
exit 1
