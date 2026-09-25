#!/usr/bin/env bash
# Run the editor harness in the agent image (it carries the GTK/NSS libraries
# VS Code needs; this host does not), against an Xvfb display on the host.
# Usage: harness/editor-docker.sh   (after npm run build && npm run build:core)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
image="${NANOCLAW_HARNESS_IMAGE:?set NANOCLAW_HARNESS_IMAGE to this install's agent image (nanoclaw-agent-v2-<install slug>:latest)}"
display=":$((90 + RANDOM % 9))"
fb="${NCL_EDITOR_FBDIR:-}"
Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp ${fb:+-fbdir "$fb"} >/dev/null 2>&1 &
xpid=$!
trap 'kill $xpid 2>/dev/null || true' EXIT
sleep 1
docker run --rm \
  -v /tmp/.X11-unix:/tmp/.X11-unix -e DISPLAY="$display" \
  -v "$here":"$here" -w "$here" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  ${NCL_EDITOR_SHOT:+-e NCL_EDITOR_SHOT="$NCL_EDITOR_SHOT" -v "$(dirname "$NCL_EDITOR_SHOT")":"$(dirname "$NCL_EDITOR_SHOT")"} \
  --entrypoint node "$image" harness/editor-review.mjs
