#!/usr/bin/env bash
#
# deploy/webchat-deploy.sh — headless, network-exposed webchat deploy.
#
# The SINGLE SOURCE OF TRUTH for a non-interactive webchat install: build the
# app, run the non-interactive setup driver, write the .env (network + bearer +
# optional Tailscale), and install a systemd service. Called by BOTH the Proxmox
# community-script (install/nanoclaw-install.sh) AND a clean-VM install, so any
# change to the deploy flow lives here — never duplicated per installer.
#
# Assumes node, pnpm, and docker are already present, and the app is already
# checked out / extracted at --dir. Works on a gitless tree (a release tarball).
# Idempotent: preserves an existing WEBCHAT_TOKEN and re-runs cleanly (see below).
#
# Usage, from a tree composed by this repo's install.sh (--dir DIR):
#   sudo bash DIR/deploy/webchat-deploy.sh --install-deps --port 3100
# (drop --install-deps if Node 22 + pnpm + Docker are already present). For a
# bare host, deploy/install.sh fetches, composes and configures in one step.
#
# Full option list:
#   --install-deps       apt-install Node 22, pnpm (corepack), Docker (docker.io +
#                        Compose) + build deps first — signed apt packages, no
#                        curl|sh. Node comes from the distro when it ships 22,
#                        else from NodeSource's signed apt repo. Debian/Ubuntu,
#                        needs root.
#   --dir DIR            app directory (default: this script's repo root)
#   --port N             webchat port (default 3100)
#   --host H             bind host (default 0.0.0.0)
#   --token T            bearer token (default: keep existing, else generate)
#   --tz TZ              timezone (default: system tz, else UTC)
#   --onecli-url URL     OneCLI gateway URL (default: derive docker-bridge:10254)
#   --no-tailscale       don't set WEBCHAT_TAILSCALE=true (it's on by default)
#   --no-service         don't install a systemd service
#   --display-name NAME  how agents address the operator (default: operator)
#   --localhost          loopback-only, single-user: bind 127.0.0.1, NO bearer
#                        token and NO Tailscale (so the localhost auto-owner
#                        stays on — any explicit auth would disable it), and a
#                        systemd --user service (no root). The most-secure mode
#                        for a personal machine; reachable only from this host.
#
# Re-running is safe: values already in .env are kept unless the matching flag
# is passed again, in which case the flag wins (--port/--host/--token/--tz/
# --onecli-url/--no-tailscale/--localhost). A running service is restarted so
# the new .env takes effect.
set -euo pipefail

DIR=""; PORT=3100; HOST=0.0.0.0; TOKEN=""; TZ_VAL=""; ONECLI_URL=""
TAILSCALE=1; SERVICE=1; DISPLAY_NAME=operator; INSTALL_DEPS=0; LOCALHOST=0
# Which settings were passed explicitly. Those overwrite .env on a re-run;
# everything else only fills a key that is missing.
PORT_SET=0; HOST_SET=0; TOKEN_SET=0; TZ_SET=0; ONECLI_SET=0; TAILSCALE_SET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --install-deps) INSTALL_DEPS=1; shift ;;
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; PORT_SET=1; shift 2 ;;
    --host) HOST="$2"; HOST_SET=1; shift 2 ;;
    --token) TOKEN="$2"; TOKEN_SET=1; shift 2 ;;
    --tz) TZ_VAL="$2"; TZ_SET=1; shift 2 ;;
    --onecli-url) ONECLI_URL="$2"; ONECLI_SET=1; shift 2 ;;
    --no-tailscale) TAILSCALE=0; TAILSCALE_SET=1; shift ;;
    --no-service) SERVICE=0; shift ;;
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    # Loopback-only: bind 127.0.0.1, no token, no Tailscale (keep auto-owner).
    # An explicit --host/--token/--tz after this still wins (last flag applies).
    --localhost) LOCALHOST=1; HOST=127.0.0.1; HOST_SET=1; TAILSCALE=0; TAILSCALE_SET=1; shift ;;
    -h|--help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0"; exit 0 ;;
    *) echo "webchat-deploy: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default DIR = the repo root this script lives in (deploy/..), so a plain
# `bash deploy/webchat-deploy.sh` from a checkout just works.
[ -n "$DIR" ] || DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || { echo "webchat-deploy: cannot cd to $DIR" >&2; exit 1; }
say() { echo "→ $*"; }

# ── 0. Prerequisites (opt-in) ────────────────────────────────────────────────
# Turn a bare Debian/Ubuntu VM into a ready host, using DISTRO packages only —
# signed + vetted by the OS, no `curl | sh` of a third-party installer. Skipped by
# default (the Proxmox framework and dev machines already have these).
NODE_MIN=22 # package.json engines; better-sqlite3 13's prebuilt crashes on Node 20
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }
if [ "$INSTALL_DEPS" = 1 ]; then
  [ "$(id -u)" = 0 ] || { echo "webchat-deploy: --install-deps needs root (apt + Docker install)" >&2; exit 1; }
  command -v apt-get >/dev/null 2>&1 || { echo "webchat-deploy: --install-deps supports Debian/Ubuntu (apt) only" >&2; exit 1; }
  export DEBIAN_FRONTEND=noninteractive
  say "Installing prerequisites from apt (Node, pnpm, Docker, build tools)…"
  apt-get update -qq
  # docker.io = Debian/Ubuntu's Docker Engine; build-essential + python3 build
  # the native modules (better-sqlite3).
  apt-get install -y -qq ca-certificates curl gnupg git build-essential python3 zstd docker.io
  # docker.io ships without Compose, and the OneCLI gateway installer needs it.
  # Ubuntu names the package docker-compose-v2; Debian, docker-compose.
  apt-get install -y -qq docker-compose-v2 2>/dev/null || apt-get install -y -qq docker-compose
  systemctl enable --now docker 2>/dev/null || true
  # Node: the distro's when it ships >= $NODE_MIN, else NodeSource's signed apt
  # repo. No current Debian or Ubuntu ships 22 (Debian 13 has 20), and Node 20
  # passes an install only to segfault at start.
  # Keeping these version pins current: docs/webchat/dependency-review.md (reviewed quarterly).
  if [ "$(node_major || true)" = "" ] || [ "$(node_major)" -lt "$NODE_MIN" ]; then
    DISTRO_NODE="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/{print $2}' | sed 's/^[0-9]*://; s/\..*//')"
    if [ -n "$DISTRO_NODE" ] && [ "$DISTRO_NODE" != "(none)" ] && [ "$DISTRO_NODE" -ge "$NODE_MIN" ] 2>/dev/null; then
      apt-get install -y -qq nodejs npm
    else
      say "Distro Node is ${DISTRO_NODE:-missing}; adding NodeSource's apt repo for Node ${NODE_MIN}…"
      install -d -m 0755 /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MIN}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
      apt-get update -qq
      apt-get install -y -qq nodejs
    fi
  fi
  # pnpm via corepack (bundled with Node); version pinned by package.json
  # "packageManager". Fallback to a global pnpm if this Node lacks corepack.
  corepack enable 2>/dev/null || npm install -g pnpm
  say "Prerequisites ready (Node $(node -v), Docker via docker.io)."
fi

# Every run, not only --install-deps: an older Node builds and installs, then
# the service crashes at start.
if [ "$(node_major || true)" = "" ] || [ "$(node_major)" -lt "$NODE_MIN" ]; then
  echo "webchat-deploy: Node is '$(node -v 2>/dev/null || echo missing)' but NanoClaw needs >= ${NODE_MIN}." >&2
  echo "  Re-run with --install-deps (Debian/Ubuntu), or install Node ${NODE_MIN} yourself (nvm, NodeSource)." >&2
  exit 1
fi

# ── 1. Build ────────────────────────────────────────────────────────────────
say "Installing dependencies + building (first run pulls a base image, be patient)…"
pnpm install --frozen-lockfile
pnpm run build
# NanoClaw's non-interactive driver builds the agent container image and sets up
# the OneCLI credential vault. Interactive steps are skipped (the browser wizard
# owns them), and so is its systemd --user service — a root system service is
# installed below instead.
say "Running the non-interactive setup driver…"
# The hardened (pre-built) image is offered through a sign-in portal, which a
# headless run cannot answer: the prompt cancels on /dev/null and setup exits 0
# part-way. Settle it as the local build unless the operator already chose.
[ -f .env ] || touch .env
chmod 600 .env # holds the bearer token and other secrets
grep -q '^NANOCLAW_HARDENED_IMAGE=' .env || echo 'NANOCLAW_HARDENED_IMAGE=false' >> .env
NANOCLAW_BOOTSTRAPPED=1 NANOCLAW_DISPLAY_NAME="$DISPLAY_NAME" \
  NANOCLAW_SKIP='auth,channel,first-chat,cli-agent,timezone,service,echo-reminder,slack-reminder' \
  NANOCLAW_HEADLESS=1 pnpm run setup:auto </dev/null
# Stamp the upgrade marker: a fetched tree carries none, so the first-boot
# dev-pull tripwire would otherwise refuse to start and crash-loop. This deploy
# IS the sanctioned path, so record it.
pnpm exec tsx scripts/upgrade-state.ts set

# ── 2. Configure .env ───────────────────────────────────────────────────────
[ -f .env ] || touch .env
chmod 600 .env
env_has() { grep -q "^$1=" .env; }
env_get() { grep "^$1=" .env | tail -n1 | cut -d= -f2- || true; }
# Add-if-missing: a default never overwrites what an operator already has.
env_set() { env_has "$1" || printf '%s=%s\n' "$1" "$2" >> .env; }
# Overwrite: for values passed explicitly on this run. awk, not sed, so a
# value holding / | & or \ is written verbatim.
# The rewrite goes through a umask-077 temp file and back into .env in place,
# so the secrets are never world-readable and .env keeps its mode.
env_put() {
  if env_has "$1"; then
    (umask 077 && K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"] "=" } index($0, k) == 1 { print k ENVIRON["V"]; next } { print }' \
      .env > .env.tmp) && cat .env.tmp > .env && rm -f .env.tmp
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
env_del() {
  env_has "$1" || return 0
  (umask 077 && { grep -v "^$1=" .env > .env.tmp || true; }) && cat .env.tmp > .env && rm -f .env.tmp
}
# explicit flag → overwrite; otherwise → fill only if missing.
env_apply() { if [ "$1" = 1 ]; then env_put "$2" "$3"; else env_set "$2" "$3"; fi; }
# A first deploy is one whose .env has never enabled webchat. Only then do the
# auth defaults (Tailscale on, a fresh token) apply: on a re-run, an operator
# who turned Tailscale off or retired the token in Settings keeps that choice.
FIRST_DEPLOY=1; env_has WEBCHAT_ENABLED && FIRST_DEPLOY=0

env_set WEBCHAT_ENABLED true
env_apply "$HOST_SET" WEBCHAT_HOST "$HOST"
env_apply "$PORT_SET" WEBCHAT_PORT "$PORT"
# Tailscale identity up front: reach this over the tailnet and the first Tailscale
# login becomes owner. Harmless when unused — the bearer token is checked first.
if [ "$TAILSCALE_SET" = 1 ] && [ "$TAILSCALE" = 0 ]; then
  env_del WEBCHAT_TAILSCALE
elif [ "$TAILSCALE" = 1 ] && [ "$FIRST_DEPLOY" = 1 ]; then
  env_set WEBCHAT_TAILSCALE true
fi
# Bearer token: LAN-exposed, so the server needs one; the first browser login
# becomes owner. Preserve any existing token (rotating it locks out current
# logins); --token replaces it; else generate one when nothing else
# authenticates (first deploy, or no Tailscale / trusted proxy configured).
# Localhost mode is the exception: NO token — 127.0.0.1 is trusted and the
# localhost auto-owner signs you in, which any explicit auth method would
# switch off, so --localhost drops a token left by a networked deploy.
if [ "$TOKEN_SET" = 1 ]; then
  env_put WEBCHAT_TOKEN "$TOKEN"
elif [ "$LOCALHOST" = 1 ]; then
  env_has WEBCHAT_TOKEN && say "Removing the bearer token (--localhost signs you in automatically)"
  env_del WEBCHAT_TOKEN
elif ! env_has WEBCHAT_TOKEN; then
  if [ "$FIRST_DEPLOY" = 1 ] || { [ "$(env_get WEBCHAT_TAILSCALE)" != true ] && [ -z "$(env_get WEBCHAT_TRUSTED_PROXY_IPS)" ]; }; then
    env_put WEBCHAT_TOKEN "$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
  fi
fi
# The OneCLI gateway (started by setup:auto) binds the docker bridge, not
# loopback. The host needs its URL to hand credentials to agent containers.
# `|| true`: without docker0 the pipeline fails, and under pipefail that would
# end the script here instead of taking the fallback.
if [ -z "$ONECLI_URL" ]; then
  bridge=$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true)
  ONECLI_URL="http://${bridge:-172.17.0.1}:10254"
fi
env_apply "$ONECLI_SET" ONECLI_URL "$ONECLI_URL"
[ -n "$TZ_VAL" ] || TZ_VAL="$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
env_apply "$TZ_SET" TZ "$TZ_VAL"
# When installing from a fork or private mirror carrying fork-only payload branches
# (e.g. `providers-grok`), persist the source repo so `from-branch` skill
# installs from Settings resolve it; a branch it does not carry still comes from
# the nanocoai default (Codex's `providers`, for one).
# Only written when provided; env-load.ts loads it into the host process, and
# env_set is add-if-missing so a re-deploy preserves an operator's value.
if [ -n "${NANOCLAW_CHANNELS_REMOTE_URL:-}" ]; then env_set NANOCLAW_CHANNELS_REMOTE_URL "$NANOCLAW_CHANNELS_REMOTE_URL"; fi
# What the server will actually use — a kept value, not this run's default —
# for the health wait and the summary below.
HOST="$(env_get WEBCHAT_HOST)"; HOST="${HOST:-0.0.0.0}"
PORT="$(env_get WEBCHAT_PORT)"; PORT="${PORT:-3100}"
say "Wrote .env (webchat on ${HOST}:${PORT})"

# ── 3. System service (root + systemd) ──────────────────────────────────────
if [ "$SERVICE" = 1 ] && [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  cat >/etc/systemd/system/nanoclaw.service <<UNIT
[Unit]
Description=NanoClaw
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=$DIR
# A system unit runs with HOME unset; onecli reads its auth token from
# \$HOME/.config, so without this every credential call is Unauthorized (exit 2).
Environment=HOME=/root
# Docker starts the onecli containers, systemd starts us, and nothing orders the
# two — so on a reboot the host can probe a gateway that is still binding its
# port. Wait for it first (warn-and-continue; never blocks the unit).
ExecStartPre=/bin/bash $DIR/deploy/wait-for-onecli.sh
# The wait budget (60s) plus node boot must fit inside the start timeout.
TimeoutStartSec=150
ExecStart=$NODE_BIN $DIR/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  # enable + restart, not `enable --now`: on a re-run the unit is already
  # running and --now would leave it on the old .env and unit. restart also
  # starts a stopped unit.
  systemctl enable nanoclaw
  systemctl restart nanoclaw
  say "Installed + (re)started the nanoclaw systemd service"
  STARTED=system
elif [ "$SERVICE" = 1 ] && [ "$LOCALHOST" = 1 ] && command -v systemctl >/dev/null 2>&1 \
     && systemctl --user show-environment >/dev/null 2>&1; then
  # Localhost dev box: a per-USER service — no root, starts now and on login.
  # (A root system service is overkill for a single-user loopback install.)
  mkdir -p "$HOME/.config/systemd/user"
  cat >"$HOME/.config/systemd/user/nanoclaw.service" <<UNIT
[Unit]
Description=NanoClaw (localhost)
After=docker.service

[Service]
Type=simple
WorkingDirectory=$DIR
# Docker starts the onecli containers, systemd starts us, and nothing orders the
# two — so on a reboot the host can probe a gateway that is still binding its
# port. Wait for it first (warn-and-continue; never blocks the unit).
ExecStartPre=/bin/bash $DIR/deploy/wait-for-onecli.sh
# The wait budget (60s) plus node boot must fit inside the start timeout.
TimeoutStartSec=150
ExecStart=$(command -v node) $DIR/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable nanoclaw
  systemctl --user restart nanoclaw # see the system unit above: a re-run must restart
  # Survive logout without a login session open (best-effort, no prompt).
  command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" 2>/dev/null || true
  say "Installed + (re)started nanoclaw as a systemd --user service"
  STARTED=user
elif [ "$SERVICE" = 1 ]; then
  say "Skipped service install (needs root+systemd, or --localhost for a --user service) — start manually: node $DIR/dist/index.js"
fi

# ── 4. Prove it started ─────────────────────────────────────────────────────
# Setup runs headless with stdin at /dev/null; a prompt it could not answer
# exits it with status 0 part-way, and the service then crash-loops. So "✓"
# is printed only once the server answers /health. The unit may first wait up
# to 60s for the OneCLI gateway (wait-for-onecli.sh), hence the budget.
if [ -n "${STARTED:-}" ]; then
  case "$HOST" in 0.0.0.0|""|"::") HEALTH_HOST=127.0.0.1 ;; *) HEALTH_HOST="$HOST" ;; esac
  say "Waiting for http://${HEALTH_HOST}:${PORT}/health …"
  if ! node -e '
    const url = process.argv[1], until = Date.now() + 150_000;
    (async () => {
      while (Date.now() < until) {
        try { if ((await fetch(url)).ok) process.exit(0); } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
      process.exit(1);
    })();' "http://${HEALTH_HOST}:${PORT}/health"; then
    echo "" >&2
    echo "webchat-deploy: NanoClaw did not come up (no answer on :${PORT}/health)." >&2
    if [ "$STARTED" = user ]; then
      journalctl --user -u nanoclaw -n 30 --no-pager >&2 || true
    else
      journalctl -u nanoclaw -n 30 --no-pager >&2 || true
    fi
    exit 1
  fi
fi

echo ""
if [ "$LOCALHOST" = 1 ]; then
  echo "✓ NanoClaw webchat deployed on 127.0.0.1:${PORT} (localhost only)."
  echo "  Open http://127.0.0.1:${PORT}/ — you're signed in as owner automatically."
else
  TOKEN_OUT=$(grep '^WEBCHAT_TOKEN=' .env | cut -d= -f2- || true)
  echo "✓ NanoClaw webchat deployed on ${HOST}:${PORT}."
  [ -n "$TOKEN_OUT" ] && echo "  Bearer token: $TOKEN_OUT"
  echo "  Open http://<this-host>:${PORT}/ and paste the token — the first login becomes owner."
fi
