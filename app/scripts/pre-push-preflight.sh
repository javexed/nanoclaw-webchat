#!/usr/bin/env sh
# Git pre-push hook: keep PRs clean across parallel dev machines by refusing to
# push a branch that's behind the base tip. Every PR then lands as a linear delta
# off the current tip instead of a stale base that has to be rebased after the
# fact (see the private ops playbook).
#
# Delegates to pr-preflight.sh (same dir). Offline → that script warns and
# passes, so this never wedges work you can't verify.
#
# Override for an intentional WIP backup:
#   SKIP_PR_PREFLIGHT=1 git push ...
#
# Install (per machine — git hooks are not cloned):
#   ln -sf ../../app/scripts/pre-push-preflight.sh .git/hooks/pre-push
[ -n "$SKIP_PR_PREFLIGHT" ] && exit 0

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
script="$root/app/scripts/pr-preflight.sh"
[ -f "$script" ] || exit 0

# Do NOT hardcode a remote name. Checkouts differ (origin here, something else
# there), and naming one that does not exist makes pr-preflight.sh take its
# "cannot fetch (offline?)" path — which PASSES. The hook then looks like it is
# protecting the branch while checking nothing at all. Let pr-preflight.sh
# discover the remote the same way everything else does.
# Pick the private remote by its URL, NOT by its name. `git remote | grep -vx
# github | head -1` looked like it excluded the public mirror, but it only
# excludes a remote literally NAMED "github" — and in a checkout where the
# GitHub remote is called `origin` (the common case) it selects exactly the
# remote it meant to skip, silently.
remote="${PR_PREFLIGHT_REMOTE:-$(git remote -v | awk '$3 == "(fetch)" && $2 !~ /github\.com/ { print $1; exit }')}"
if [ -z "$remote" ]; then
  echo "pre-push: no non-public remote to check against — skipping freshness check" >&2
  exit 0
fi

if ! PR_PREFLIGHT_BASE=main sh "$script" main HEAD; then
  echo "" >&2
  echo "  pre-push blocked: this branch is behind $remote/main." >&2
  echo "    git fetch $remote main && git rebase $remote/main" >&2
  echo "    (intentional WIP backup? SKIP_PR_PREFLIGHT=1 git push ...)" >&2
  exit 1
fi
exit 0
