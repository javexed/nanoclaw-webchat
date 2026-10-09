#!/usr/bin/env bash
# fresh-box-check.sh — install this checkout's pins on a stock, fresh machine.
#
#   bash scripts/fresh-box-check.sh            # the committed HEAD of this checkout
#
# CI and the release host both arrive with the toolchain already in place
# (pnpm/action-setup, a developer's PATH), so neither can see an install.sh that
# assumes something a new machine does not have. That is how a fresh-box install
# died at "pnpm: command not found" with every gate green. This starts from the
# documented prerequisites only: a stock Node image, plus git to fetch this repo,
# as an ordinary user with no pnpm, and runs install.sh exactly as a user would.
#
# It composes without the container image (SKIP_CONTAINER_BUILD=1): the image
# build needs Docker inside the box and is covered elsewhere. What it proves is
# that the install's own prerequisites and bootstrapping hold on a new machine.
#
# Needs Docker on the host and network access (it clones the pinned upstream and
# seam, and installs dependencies). Takes a few minutes.
#
# Env:
#   FRESH_BOX_IMAGE              the box (default node:22-bookworm-slim, the .nvmrc line)
#   NANOCLAW_WEBCHAT_SEAM_REPO   passed through, to test against an unpublished or mirrored seam repo
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR="$(sed -E 's/^v//; s/\..*//' "$HERE/.nvmrc" 2>/dev/null || true)"
IMAGE="${FRESH_BOX_IMAGE:-node:${NODE_MAJOR:-22}-bookworm-slim}"
say() { printf '\033[1;36m[fresh-box]\033[0m %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || { echo "fresh-box-check: needs Docker on this host" >&2; exit 2; }
[ -z "$(git -C "$HERE" status --porcelain)" ] \
  || say "note: uncommitted changes are NOT tested — the box clones the committed HEAD ($(git -C "$HERE" rev-parse --short HEAD))"

say "installing $(git -C "$HERE" rev-parse --short HEAD) on a stock $IMAGE, as a non-root user with no pnpm"
# The repo is mounted read-only and CLONED inside, so the box gets the committed
# tree and nothing from this host's working copy, node_modules or caches.
docker run --rm \
  -v "$HERE":/src:ro \
  -e SEAM="${NANOCLAW_WEBCHAT_SEAM_REPO:-}" \
  "$IMAGE" bash -c '
    set -e
    # Only what it takes to fetch the repo. Anything else install.sh needs, it
    # must either set up itself or list as a prerequisite.
    apt-get update -qq >/dev/null && apt-get install -y -qq git ca-certificates >/dev/null
    useradd -m box
    if command -v pnpm >/dev/null 2>&1; then echo "image ships pnpm — not a fresh box" >&2; exit 2; fi
    su box -c "
      set -e
      # /src belongs to the host user, and the upload-pack behind a local clone reads only global config.
      git config --global --add safe.directory /src/.git
      git clone -q /src \$HOME/repo
      cd \$HOME/repo
      ${SEAM:+NANOCLAW_WEBCHAT_SEAM_REPO=\"$SEAM\"} SKIP_CONTAINER_BUILD=1 bash install.sh --dir \$HOME/nanoclaw
    "
  '
say "OK — a fresh box installs these pins"
