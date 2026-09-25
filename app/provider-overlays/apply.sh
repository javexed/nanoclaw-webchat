#!/usr/bin/env bash
# Provider overlays: webchat's changes to a provider's own files, applied only
# once that provider is installed. Run from the install root — by install.sh at
# compose time, and again by the Settings install chain after a provider skill
# copies its files in. Idempotent: an overlay already applied is skipped.
# Exits 1 if any overlay does not apply.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# marker (a file the provider's skill installs) | patch | extra file src:dest
OVERLAYS=(
  "container/agent-runner/src/providers/codex.ts|codex-activity.patch|codex-activity.test.ts:container/agent-runner/src/providers/codex-activity.test.ts"
)

failed=0
for entry in "${OVERLAYS[@]}"; do
  IFS='|' read -r marker patch extra <<< "$entry"
  if [ ! -f "$marker" ]; then
    echo "  = ${patch}: provider not installed — skip"
    continue
  fi
  if git apply --reverse --check "$HERE/$patch" 2>/dev/null; then
    echo "  = ${patch}: already applied (skip)"
  elif git apply "$HERE/$patch" 2>/dev/null; then
    echo "  → ${patch}: applied"
  else
    echo "  !! ${patch}: does not apply — left unchanged" >&2
    failed=1
    continue
  fi
  if [ -n "${extra:-}" ]; then
    IFS=':' read -r esrc edst <<< "$extra"
    cp "$HERE/$esrc" "$edst" && echo "  → ${edst##*/}: installed"
  fi
done
exit "$failed"
