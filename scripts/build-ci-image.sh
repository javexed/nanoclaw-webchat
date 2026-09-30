#!/usr/bin/env bash
# build-ci-image.sh — build a CI job image with Chromium's libraries (ci/image).
#
#   scripts/build-ci-image.sh                       # on the default act base
#   CI_IMAGE_BASE=<image> scripts/build-ci-image.sh # on your runner's own base
#   CI_IMAGE_TAG=<name>   scripts/build-ci-image.sh # tag (default nanoclaw-webchat-ci)
#
# Tags <name>:pw-<version> and <name>:latest. Run it where the runner's Docker
# can see the image, then point the runner's job image at it — for an act-based
# runner, a label mapping in its config.yaml:
#
#   runner:
#     labels:
#       - "ubuntu-latest:docker://nanoclaw-webchat-ci:latest"
#
# Rebuilding after a Playwright bump is optional: the libraries rarely change
# between versions, and when they do the workflow's launch probe fails and it
# installs what is missing.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$HERE/ui/package.json').devDependencies.playwright")"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "build-ci-image: ui/package.json pins no exact playwright version (got '$VERSION')" >&2; exit 2 ;;
esac
TAG="${CI_IMAGE_TAG:-nanoclaw-webchat-ci}"
docker build \
  ${CI_IMAGE_BASE:+--build-arg "BASE=$CI_IMAGE_BASE"} \
  --build-arg "PLAYWRIGHT_VERSION=$VERSION" \
  -t "$TAG:pw-$VERSION" \
  -t "$TAG:latest" \
  "$HERE/ci/image"
echo "built $TAG:pw-$VERSION (and :latest)"
