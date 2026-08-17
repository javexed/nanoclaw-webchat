#!/usr/bin/env sh
# pr-preflight.sh — verify a branch is built on the current base tip
# before it becomes a PR. The failure mode this guards: opening a PR from a
# stale base (this repo carries ~50 feature branches sitting 60–700 commits
# behind channels-webchat). "At the top" means <remote>/<base> is an ancestor
# of the ref — i.e. the branch already contains every base commit, so the PR
# is a clean fast-forward-friendly delta.
#
# Usage:  scripts/pr-preflight.sh [BASE] [REF]
#   BASE  base branch to check against           (default: channels-webchat,
#         overridable via PR_PREFLIGHT_BASE)
#   REF   commit/ref to evaluate                 (default: HEAD)
#
# Exit 0 = at the top (safe to PR). Exit 1 = behind (rebase first).
# Fetch failures (offline) warn and pass — never wedge work you can't verify.
set -eu

base="${1:-${PR_PREFLIGHT_BASE:-channels-webchat}}"
ref="${2:-HEAD}"
# Default to the first remote that is not the public mirror, so no instance
# name is hardcoded in a published file. Override with PR_PREFLIGHT_REMOTE.
# Pick the private remote by its URL, NOT by its name. `git remote | grep -vx
# github | head -1` looked like it excluded the public mirror, but it only
# excludes a remote literally NAMED "github" — and in a checkout where the
# GitHub remote is called `origin` (the common case) it selects exactly the
# remote it meant to skip, silently.
remote="${PR_PREFLIGHT_REMOTE:-$(git remote -v | awk '$3 == "(fetch)" && $2 !~ /github\.com/ { print $1; exit }')}"
upstream="$remote/$base"

# Refuse to guess if the ref doesn't resolve.
if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
  echo "pr-preflight: cannot resolve ref '$ref'" >&2
  exit 1
fi

# Refresh the base. If we can't reach the remote, warn and let the push through —
# a guard that blocks all offline work is worse than the staleness it prevents.
if ! git fetch --quiet "$remote" "$base" 2>/dev/null; then
  echo "pr-preflight: WARNING could not fetch $upstream (offline?) — skipping freshness check" >&2
  exit 0
fi

if ! git rev-parse --verify --quiet "$upstream^{commit}" >/dev/null; then
  echo "pr-preflight: WARNING $upstream not found after fetch — skipping freshness check" >&2
  exit 0
fi

behind="$(git rev-list --count "$ref..$upstream")"
ahead="$(git rev-list --count "$upstream..$ref")"

# A PR delta in the hundreds means this is measuring against the WRONG base —
# almost always a stale public mirror that the real work never lands on. That
# is not hypothetical: with the old name-based remote selection this script
# compared against GitHub's main, reported "at the top of origin/main. PR would
# contain 314 commit(s)", exited 0, and let a branch push that was six commits
# behind the actual base. The count was the only visible tell and nothing drew
# attention to it. Warn loudly; do not block, since a genuinely large PR is
# possible and this script's contract is to warn rather than wedge.
if [ "$ahead" -gt 50 ]; then
  echo "" >&2
  echo "  !! pr-preflight: $ahead commit(s) ahead of $upstream — that is a lot for one PR." >&2
  echo "     If '$remote' is not where these branches actually land, this check is measuring" >&2
  echo "     nothing. Confirm with:  git remote -v" >&2
  echo "" >&2
fi

if [ "$behind" -ne 0 ]; then
  echo "" >&2
  echo "  ✗ pr-preflight: branch is $behind commit(s) behind $upstream." >&2
  echo "    Rebase onto the current tip before opening a PR:" >&2
  echo "" >&2
  echo "        git fetch $remote $base && git rebase $upstream" >&2
  echo "" >&2
  echo "    (intentional WIP backup? push with:  SKIP_PR_PREFLIGHT=1 git push ...)" >&2
  exit 1
fi

if [ "$ahead" -eq 0 ]; then
  echo "  ✓ pr-preflight: at $upstream tip — no new commits to PR." >&2
else
  echo "  ✓ pr-preflight: at the top of $upstream. PR would contain $ahead commit(s):" >&2
  git --no-pager log --oneline "$upstream..$ref" >&2
fi
exit 0
