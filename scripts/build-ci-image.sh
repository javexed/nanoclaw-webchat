#!/usr/bin/env bash
# build-ci-image.sh — build the webchat CI job's container (ci/runner-image).
#
#   scripts/build-ci-image.sh          # build nanoclaw-webchat-ci:pw-<version> and :latest
#
# Run on the runner host, where the runner's Docker can see the image. Rebuild
# only when ui/'s Playwright version changes; until then the workflow notices
# the mismatch and installs the libraries itself (slower, not broken).
#
# Then point the runner's `ubuntu-latest` label at it, in the runner's
# config.yaml:
#
#   runner:
#     labels:
#       - "ubuntu-latest:docker://nanoclaw-webchat-ci:latest"
#
# and restart the runner.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$HERE/ui/package.json').devDependencies.playwright")"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "build-ci-image: ui/package.json pins no exact playwright version (got '$VERSION')" >&2; exit 2 ;;
esac
docker build \
  --build-arg "PLAYWRIGHT_VERSION=$VERSION" \
  -t "nanoclaw-webchat-ci:pw-$VERSION" \
  -t nanoclaw-webchat-ci:latest \
  "$HERE/ci/runner-image"
echo "built nanoclaw-webchat-ci:pw-$VERSION (and :latest)"
