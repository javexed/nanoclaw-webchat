#!/usr/bin/env bash
# Migrate a live fork-era webchat install (channels-webchat checkout or
# tarball install) to the split app IN PLACE. Design + constraints:
# app/docs/webchat/design/migrate-from-fork.md — grounded in the two
# production cutovers this scripts.
#
#   scripts/migrate-from-fork.sh <install-dir> [--composed <dir>] [--dry-run]
#
# State (data/, groups/, .env, logs/, OneCLI vault) is never touched. Every
# step before the service restart leaves the old code running; after the
# restart, the printed rollback recipe restores it wholesale.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="${1:?usage: migrate-from-fork.sh <install-dir> [--composed <dir>] [--dry-run]}"; shift || true
COMPOSED=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --composed) COMPOSED="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
INSTALL="$(cd "$INSTALL" && pwd)"
say() { printf '\033[1;36m[migrate]\033[0m %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then echo "  DRY: $*"; else "$@"; fi; }

[ -f "$INSTALL/package.json" ] || { echo "ERROR: $INSTALL is not a nanoclaw install" >&2; exit 1; }
STAMP="$(date +%Y%m%d-%H%M%S)"

# ── 1. detect type + snapshot ────────────────────────────────────────────────
if [ -d "$INSTALL/.git" ]; then
  TYPE=git
  say "git checkout detected — snapshot branch wip/pre-split-$STAMP"
  run git -C "$INSTALL" branch -f "wip/pre-split-$STAMP" HEAD
else
  TYPE=tarball
  say "tarball install detected — adopting a repo (git init + baseline commit)"
  run git -C "$INSTALL" init -q
  run git -C "$INSTALL" add -A
  run git -C "$INSTALL" -c user.name=migrate -c user.email=migrate@localhost \
      commit -qm "baseline: pre-split tarball install ($STAMP)"
  run git -C "$INSTALL" branch -f "wip/pre-split-$STAMP" HEAD
fi

# ── 2. newer-fork refusal ────────────────────────────────────────────────────
FORK_REF=$(python3 -c "import json;print(json.load(open('$HERE/versions.json'))['nanoclaw']['forkRef'])")
if [ "$TYPE" = git ] && git -C "$INSTALL" cat-file -e "$FORK_REF" 2>/dev/null; then
  if ! git -C "$INSTALL" merge-base --is-ancestor HEAD "$FORK_REF" 2>/dev/null \
     && [ "$(git -C "$INSTALL" rev-parse HEAD)" != "$FORK_REF" ]; then
    echo "ERROR: this install is NEWER than the split's forkRef pin ($FORK_REF)." >&2
    echo "Migrating would silently drop fork-side changes you are running:" >&2
    git -C "$INSTALL" diff --name-only "$FORK_REF"..HEAD | head -40 >&2
    echo "Update this repo's pins first (see docs/webchat/upstream-drift.md)." >&2
    exit 1
  fi
else
  say "WARN: cannot compare against forkRef (no shared history) — proceeding; review the diff after the flip"
fi

# ── 3. compose (unless provided) ─────────────────────────────────────────────
if [ -z "$COMPOSED" ]; then
  COMPOSED="$(mktemp -d)/composed"
  say "composing fresh tree at $COMPOSED"
  run bash "$HERE/install.sh" --dir "$COMPOSED" --skip-build
fi
if [ "$DRY" = 0 ]; then
  git -C "$COMPOSED" add -A >/dev/null
  git -C "$COMPOSED" -c user.name=migrate -c user.email=migrate@localhost \
      commit -qm "composed for migrate-from-fork $STAMP" 2>/dev/null || true
fi

# ── 4. flip in place (atomic on tracked files; state is untracked) ──────────
say "flipping $INSTALL to the composed tree (branch composed-live-$STAMP)"
run git -C "$INSTALL" fetch -q "$COMPOSED" HEAD
run git -C "$INSTALL" branch -f "composed-live-$STAMP" FETCH_HEAD
DOCKER_CHANGED=0
if [ "$DRY" = 0 ]; then
  if ! git -C "$INSTALL" diff --quiet "wip/pre-split-$STAMP" "composed-live-$STAMP" -- container/Dockerfile; then
    DOCKER_CHANGED=1
  fi
fi
run git -C "$INSTALL" checkout -q "composed-live-$STAMP"

# ── 5. deps + build ──────────────────────────────────────────────────────────
say "installing deps + building"
run bash -c "cd '$INSTALL' && pnpm install --frozen-lockfile && pnpm run build"
if [ "$DOCKER_CHANGED" = 1 ]; then
  say "Dockerfile changed — rebuilding agent image"
  run bash -c "cd '$INSTALL' && ./container/build.sh"
else
  say "Dockerfile unchanged — no image rebuild (runner source is bind-mounted)"
fi

# ── 6. upgrade marker (tripwire) ─────────────────────────────────────────────
say "restamping upgrade marker (args are positional: version, via)"
run bash -c "cd '$INSTALL' && pnpm exec tsx scripts/upgrade-state.ts set '' migrate-from-fork"

# ── 7. served frontend dir, if split from the checkout ──────────────────────
PUBDIR=$(grep -E '^WEBCHAT_PUBLIC_DIR=' "$INSTALL/.env" 2>/dev/null | cut -d= -f2- || true)
if [ -n "$PUBDIR" ]; then
  say "syncing public/webchat → $PUBDIR (WEBCHAT_PUBLIC_DIR is set)"
  run rsync -a --delete "$INSTALL/public/webchat/" "$PUBDIR/"
fi

# ── 8. restart + smoke ───────────────────────────────────────────────────────
UNIT=$(systemctl --user list-units --plain --no-legend 'nanoclaw*' 2>/dev/null | awk '{print $1}' | head -1 || true)
if [ -n "$UNIT" ]; then
  say "restarting $UNIT"
  run systemctl --user restart "$UNIT"
  if [ "$DRY" = 0 ]; then
    say "waiting for 'NanoClaw running' (60s)"
    ok=0
    for i in $(seq 1 30); do
      sleep 2
      tail -5 "$INSTALL/logs/nanoclaw.log" 2>/dev/null | grep -q "NanoClaw running" && { ok=1; break; }
    done
    [ "$ok" = 1 ] && say "smoke: host is up" || echo "WARN: host not confirmed up — check logs/nanoclaw.error.log" >&2
  fi
else
  say "no systemd user unit found — restart the host yourself (launchd: launchctl kickstart -k gui/\$(id -u)/com.nanoclaw)"
fi

say "DONE. Rollback at any time:"
echo "  git -C $INSTALL checkout wip/pre-split-$STAMP && cd $INSTALL && pnpm install --frozen-lockfile && pnpm run build \\"
echo "    && pnpm exec tsx scripts/upgrade-state.ts set '' rollback && systemctl --user restart ${UNIT:-<your-unit>}"
