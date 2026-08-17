#!/usr/bin/env bash
# publish-release.sh — push a STAGED release to the PUBLIC repo.
#
#   scripts/publish-release.sh vX.Y.Z [--dry-run]
#
# Deliberately separate from release.sh. Publishing pushes a tag to a public
# `main` and creates a GitHub release — an outward-facing step that
# needs its own explicit yes. Folding it into release.sh meant one "cut the
# release" silently authorised the public push; splitting it back out restores
# the review point that rule exists for.
#
# Ships the artifact release.sh already gated (dist/releases/), never a rebuild
# — so what is published is exactly the bytes that passed compose, manifest and
# both suites.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:?usage: publish-release.sh vX.Y.Z [--dry-run]}"; shift || true
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "version must look like v2.3.0" >&2; exit 2; }

PUBLIC=https://github.com/javexed/nanoclaw-webchat.git
ASSET="nanoclaw-webchat-composed-${VERSION}.tar.gz"
KEEP="$HERE/dist/releases/$ASSET"
NOTES="$HERE/dist/releases/$VERSION.notes.md"

say() { printf '\033[1;36m[publish]\033[0m %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then echo "  DRY: $*"; else "$@"; fi; }

cd "$HERE"
# The staged artifact is the contract between the two commands: no artifact
# means the gates never ran for this version, and publishing would ship
# something unverified.
[ -f "$KEEP" ] || { echo "no staged artifact for $VERSION at $KEEP — run scripts/release.sh $VERSION first" >&2; exit 1; }
git rev-parse "$VERSION" >/dev/null 2>&1 || { echo "$VERSION is not tagged locally — run scripts/release.sh $VERSION first" >&2; exit 1; }
gh release view "$VERSION" --repo javexed/nanoclaw-webchat >/dev/null 2>&1 \
  && { echo "$VERSION is already published" >&2; exit 1; }
SIZE=$(du -h "$KEEP" | cut -f1)
say "publishing $VERSION ($SIZE) to the PUBLIC repo"

# The public repo carries REAL, SHARED history now, so the snapshot dance this
# used to perform is gone: there is no separate snapshot commit to tag, and a
# tag push can no longer drag an unrelated history along with it. Tag the
# release commit itself — after confirming it is actually published.
#
# The old path shelled out to a sync script kept OUTSIDE this repo. A public
# script cannot depend on a private one: anyone else running it hits a missing
# file, and the reference advertises private infrastructure. That script was
# also retired with the snapshot mirror and now exits 1, so this was dead.
if [ "$DRY" = 0 ]; then
  git -c credential.helper= -c credential.helper='!gh auth git-credential' fetch -q "$PUBLIC" main
  # The release commit must already BE on public main. Tagging something never
  # pushed would advertise an artifact nobody can reproduce from the public tree.
  git merge-base --is-ancestor "$VERSION^{commit}" FETCH_HEAD \
    || { echo "$VERSION is not an ancestor of public main — publish the release commit first" >&2; exit 1; }
  # Parity: what is public must be the tree that was gated, or the release would
  # advertise an artifact built from something else.
  [ "$(git rev-parse 'FETCH_HEAD^{tree}')" = "$(git rev-parse "$VERSION^{tree}")" ] \
    || { echo "public main tree != the tagged tree — publish the release commit first" >&2; exit 1; }
  git -c credential.helper= -c credential.helper='!gh auth git-credential' \
    push -q "$PUBLIC" "refs/tags/$VERSION"
  say "tagged $VERSION on public main"

  gh release create "$VERSION" "$KEEP#Composed install ($SIZE)" \
    --repo javexed/nanoclaw-webchat --title "nanoclaw-webchat $VERSION" --notes-file "$NOTES" \
    || { echo "gh release create FAILED (tag is pushed; re-run this script)" >&2; exit 1; }
  say "verifying the asset is downloadable"
  gh release view "$VERSION" --repo javexed/nanoclaw-webchat --json assets \
    --jq '.assets[].name' | grep -q "$ASSET" || { echo "asset missing from the release" >&2; exit 1; }
else
  echo "  DRY: push tag $VERSION to public main"
  echo "  DRY: gh release create $VERSION --repo javexed/nanoclaw-webchat (asset: $KEEP)"
fi
say "DONE — $VERSION published with $ASSET"
