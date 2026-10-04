#!/usr/bin/env bash
# install-routing.sh — layer the shadow routing classifier onto an installed
# LiteLLM router (see .claude/skills/add-litellm). Idempotent; re-run freely.
#
#   bash install-routing.sh [--port 4000] [--name nanoclaw-litellm]
#                           [--image ghcr.io/berriai/litellm:v1.90.0]
#
# What it does:
#   1. Preflight: LiteLLM config exists (add-litellm ran) + docker present.
#   2. Seeds data/litellm/routing/routes.json from routes.example.json when
#      absent (NEVER overwrites — route descriptions are operator-tuned).
#   3. Copies router_hook.py into data/litellm/ (always — hook code is owned
#      by this skill).
#   4. Ensures config.yaml carries `callbacks: router_hook.proxy_handler_instance`
#      under litellm_settings. NOTE: gen-config.mjs regenerates config.yaml on
#      add-litellm re-runs — re-run THIS installer afterwards to re-add the line
#      (documented in both skills).
#   5. Recreates the container with the hook + routing mounts through the
#      add-litellm installer (--reuse-config --mount …), so its port, name,
#      proxy auth and OneCLI gateway settings are the ones it owns.
#   6. Runs the hook's unit tests inside the image.
set -euo pipefail

PORT=4000
NAME=nanoclaw-litellm
IMAGE=ghcr.io/berriai/litellm:v1.90.0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    *) echo "install-routing: unknown flag $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
# Repo root from this script's location, as install-litellm.sh does.
TOPLEVEL="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || true)"
cd "${TOPLEVEL:-$(cd "$HERE/../../../.." && pwd)}"
LITELLM_INSTALLER="$HERE/../../add-litellm/resources/install-litellm.sh"
OUT_DIR=data/litellm
CONFIG="$OUT_DIR/config.yaml"
ROUTING_DIR="$OUT_DIR/routing"

# ── 1. Preflight ──────────────────────────────────────────────────────────
command -v docker >/dev/null || { echo "install-routing: docker required" >&2; exit 1; }
[ -f "$CONFIG" ] || {
  echo "install-routing: $CONFIG not found — run the /add-litellm installer first." >&2
  exit 1
}

# ── 2. Seed routes.json (never overwrite operator tuning) ─────────────────
mkdir -p "$ROUTING_DIR"
if [ ! -f "$ROUTING_DIR/routes.json" ]; then
  cp "$HERE/routes.example.json" "$ROUTING_DIR/routes.json"
  echo "→ Seeded $ROUTING_DIR/routes.json — EDIT IT: set your classifier host + route↔model bindings."
else
  echo "= routes.json present (operator-owned) — left untouched."
fi

# ── 3. Hook code (skill-owned, always refreshed) ──────────────────────────
cp "$HERE/router_hook.py" "$OUT_DIR/router_hook.py"

# ── 4. Callback wiring in config.yaml ─────────────────────────────────────
if ! grep -q 'callbacks: router_hook.proxy_handler_instance' "$CONFIG"; then
  # Insert directly under litellm_settings: (gen-config always emits the block).
  sed -i 's/^litellm_settings:/litellm_settings:\n  callbacks: router_hook.proxy_handler_instance/' "$CONFIG"
  echo "→ Wired callbacks into config.yaml."
else
  echo "= callbacks already wired."
fi

# ── 5. Recreate the container with routing mounts ─────────────────────────
[ -f "$LITELLM_INSTALLER" ] || { echo "install-routing: $LITELLM_INSTALLER not found — the add-litellm skill is required." >&2; exit 1; }
echo "→ Restarting the router with the routing hook on port ${PORT} …"
bash "$LITELLM_INSTALLER" --reuse-config --port "$PORT" --name "$NAME" --image "$IMAGE" \
  --mount "$(pwd)/$OUT_DIR/router_hook.py:/app/router_hook.py:ro" \
  --mount "$(pwd)/$ROUTING_DIR:/app/routing"

# ── 6. Unit tests ─────────────────────────────────────────────────────────
echo "✓ LiteLLM healthy with routing hook."

echo "→ Hook unit tests (inside the image) …"
docker run --rm -v "$HERE:/t:ro" --entrypoint python "$IMAGE" \
  -m unittest discover -s /t -p 'test_*.py' 2>&1 | tail -2

cat <<EOF

✓ Shadow routing installed.

  Route catalog:   $ROUTING_DIR/routes.json   (edit descriptions/bindings, then re-run)
  Decisions log:   $ROUTING_DIR/routing-shadow.jsonl
  Review:          tail -f $ROUTING_DIR/routing-shadow.jsonl

Shadow mode by default: requests are never modified until you set
"live": {"enabled": true} in routes.json — then ONLY requests naming the
virtual model ("auto") are rewritten (see SKILL.md "Going live").
Re-running the /add-litellm installer removes the hook wiring — re-run this
installer afterwards (until then, "auto" requests fail loudly).
EOF
