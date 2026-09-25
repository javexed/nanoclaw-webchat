#!/usr/bin/env bash
# ── NanoClaw fresh-host installer ───────────────────────────────────────────
# Installs NanoClaw + the webchat setup wizard on a FRESH Debian/Ubuntu host — a
# VM, a Raspberry Pi, bare metal, or a container guest — and leaves it printing a
# browser URL + bearer token. Everything credential- and model-related (Claude/
# Codex sign-in, or local Ollama install + model download, or the first agent) is
# done by the operator in that browser wizard — this script never touches auth
# and needs no API key.
#
#   curl -fsSL https://raw.githubusercontent.com/javexed/nanoclaw-webchat/main/app/deploy/install.sh | sudo bash
#
# It clones this repo (nanoclaw-webchat), composes the install with the repo's
# root install.sh (which fetches the pinned NanoClaw and layers webchat on
# top), then leans on NanoClaw's own non-interactive setup driver (`pnpm run setup:auto`)
# for the deps/Docker/OneCLI/agent-image/service steps — the interactive ones
# (auth, channel, first-chat, cli-agent, timezone) are skipped because the wizard
# owns them. Only the webchat .env + bearer token are seeded here.
#
# Works on x86_64 and arm64 (Raspberry Pi). On a Pi the Claude/API path is the
# sweet spot; local models (Ollama) want an x86 box with more RAM.
set -euo pipefail

# Minimal Debian images (esp. LXC templates) inherit LANG=en_US.UTF-8 from the
# caller but never generated that locale, so apt/perl spew "Cannot set LC_*"
# warnings and fall back to C. C.UTF-8 is built into glibc (no locale-gen), so
# forcing it quiets the noise without installing anything.
export LANG=C.UTF-8 LC_ALL=C.UTF-8

# ── Config (env-overridable) ────────────────────────────────────────────────
# REPO_URL/REPO_BRANCH name THIS repo (the webchat overlay), not NanoClaw: the
# NanoClaw version it composes onto is pinned in the repo's versions.json.
REPO_URL="${NANOCLAW_REPO_URL:-https://github.com/javexed/nanoclaw-webchat.git}"
REPO_BRANCH="${NANOCLAW_REPO_BRANCH:-main}"
SRC_DIR="${NANOCLAW_SRC_DIR:-/opt/nanoclaw-webchat}" # the overlay checkout (compose input)
INSTALL_DIR="${NANOCLAW_DIR:-/opt/nanoclaw}"         # the composed, running install
RUN_USER="${NANOCLAW_USER:-nanoclaw}"
# An explicitly exported WEBCHAT_PORT replaces the port on a re-run; the
# default only applies to a fresh .env.
WEBCHAT_PORT_SET=0
[ -n "${WEBCHAT_PORT:-}" ] && WEBCHAT_PORT_SET=1
WEBCHAT_PORT="${WEBCHAT_PORT:-3100}"
DISPLAY_NAME="${NANOCLAW_DISPLAY_NAME:-operator}"

log() { echo -e "\033[1;36m[nanoclaw]\033[0m $*"; }
die() {
  echo -e "\033[1;31m[nanoclaw] ERROR:\033[0m $*" >&2
  exit 1
}
[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash install.sh)"
command -v apt-get >/dev/null || die "this provisioner targets Debian/Ubuntu (apt)"

# ── CPU capability preflight (x86 only) ─────────────────────────────────────
# The Claude Code CLI is a native x86 binary that needs AVX2/SSE4.2. On an x86 VM
# whose CPU model hides them (e.g. Proxmox's default kvm64, "Common KVM
# processor") it HANGS silently — the webchat OAuth sign-in mint times out and
# Claude agent turns stall — while node/bun/curl run fine, so the cause is
# invisible. Warn loudly so it's a two-minute fix (set the VM CPU type to 'host'
# — on Proxmox `qm set <id> --cpu host` — and reboot), not an hour of
# head-scratching. Non-fatal: the install and the local-model path still work.
# arm64 (Raspberry Pi) runs a different binary and is unaffected — skip it there.
if [ "$(uname -m)" = "x86_64" ] && [ -r /proc/cpuinfo ] && ! grep -qm1 avx2 /proc/cpuinfo; then
  echo -e "\033[1;33m
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  WARNING: this x86 CPU has no AVX2. The Claude Code CLI will HANG on it,  │
  │  so Claude sign-in and Claude agent turns won't work (local models still │
  │  will). On a VM: set the CPU type to 'host' (on Proxmox: qm set <id>     │
  │  --cpu host) and reboot. Continuing the install…                          │
  └─────────────────────────────────────────────────────────────────────────┘\033[0m" >&2
fi

# ── 0. Let first-boot cloud-init finish ─────────────────────────────────────
# On a fresh cloud image, cloud-init runs its own apt at first boot
# (package_update/package_upgrade) and holds the dpkg lock for MINUTES. Racing
# it makes our apt fail with "Unable to acquire the dpkg frontend lock". Wait
# for cloud-init to declare done, then wait out any lingering apt/dpkg lock.
if command -v cloud-init >/dev/null 2>&1; then
  log "waiting for cloud-init to finish (first-boot apt can take a few minutes)…"
  cloud-init status --wait >/dev/null 2>&1 || true
fi
if command -v fuser >/dev/null 2>&1; then
  for _ in $(seq 1 120); do
    fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || break
    sleep 5
  done
fi

# ── 1. OS deps ──────────────────────────────────────────────────────────────
# git/curl to fetch; build-essential+python3 for better-sqlite3's native build;
# zstd for the wizard's Ollama tarball; ca-certificates for TLS fetches.
# -o DPkg::Lock::Timeout=300: belt-and-braces — if something still holds the
# lock, wait up to 5 min for it rather than failing instantly.
log "installing OS packages…"
export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-o DPkg::Lock::Timeout=300"
apt-get $APT_OPTS update -qq
apt-get $APT_OPTS install -y -qq git curl ca-certificates gnupg build-essential python3 zstd sudo >/dev/null

# ── 2. Service user ─────────────────────────────────────────────────────────
if ! id "$RUN_USER" >/dev/null 2>&1; then
  log "creating service user '$RUN_USER'…"
  useradd --create-home --shell /bin/bash "$RUN_USER"
fi
RUN_UID="$(id -u "$RUN_USER")"
# The NanoClaw service and (later) rootless Ollama run as `systemctl --user`
# units — linger keeps that per-user systemd manager alive without a login
# session. NB: the manager caches group membership at launch; §4 refreshes it
# after the docker group is added.
loginctl enable-linger "$RUN_USER" || log "warn: could not enable linger (systemctl --user may need a manual re-enable)"

# ── 3. Node 22 (nodesource) + pnpm ──────────────────────────────────────────
# setup:auto is `tsx setup/auto.ts`, so Node + the repo deps must exist FIRST —
# chicken/egg the `environment` step can't solve. Reuse the repo's own idempotent
# installer once the repo is cloned; bootstrap Node here so the clone can build.
if ! command -v node >/dev/null 2>&1; then
  log "installing Node 22…"
  # Add the NodeSource apt repo via a pinned keyring instead of piping their
  # setup_22.x script to bash. apt then verifies `nodejs` against the signed
  # repo — no arbitrary remote code runs as root. (curl feeds gpg here, not sh.)
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get $APT_OPTS update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null 2>&1 || true

# ── 4. Docker (agent containers) ────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker…"
  # Add Docker's official apt repo via a pinned keyring instead of piping
  # get.docker.com to sh — same docker-ce, but apt-signature-verified. On a
  # brand-new distro codename Docker hasn't published a repo for yet, fall back
  # to the distro's own signed docker.io (the path webchat-deploy.sh uses).
  . /etc/os-release
  DOCKER_ID="${ID:-debian}"
  [ "$DOCKER_ID" = ubuntu ] || DOCKER_ID=debian # debian/raspbian/other → debian
  install -m 0755 -d /etc/apt/keyrings
  if curl -fsSL "https://download.docker.com/linux/${DOCKER_ID}/gpg" -o /etc/apt/keyrings/docker.asc &&
    chmod a+r /etc/apt/keyrings/docker.asc &&
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DOCKER_ID} ${VERSION_CODENAME:-} stable" \
      >/etc/apt/sources.list.d/docker.list &&
    apt-get $APT_OPTS update -qq &&
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null; then
    log "installed docker-ce from Docker's signed apt repo"
  else
    log "Docker CE repo unavailable for this release; falling back to distro docker.io…"
    rm -f /etc/apt/sources.list.d/docker.list
    apt-get $APT_OPTS update -qq
    apt-get install -y -qq docker.io >/dev/null
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
# Ensure the service user can reach the daemon socket (idempotent — runs even
# when Docker was already present).
usermod -aG docker "$RUN_USER"
# The per-user systemd manager (started by enable-linger above) resolved its
# supplementary groups BEFORE this usermod, so the NanoClaw service it spawns
# would inherit a stale set WITHOUT `docker` and crash on `docker info`
# ("Container runtime failed to start"). Restart the manager so it — and every
# unit under it — picks up the docker group, then wait for its control socket.
systemctl restart "user@${RUN_UID}.service" 2>/dev/null || true
for _ in $(seq 1 30); do
  [ -S "/run/user/${RUN_UID}/systemd/private" ] && break
  sleep 1
done

# ── 5. Fetch this repo + compose ────────────────────────────────────────────
# Everything below runs as the service user, so the trees are theirs and git
# never trips over "dubious ownership" on a re-run.
# XDG_RUNTIME_DIR lets setup:auto's `service` step reach the per-user systemd
# manager (systemctl --user) from this non-login sudo shell — without it the
# service never installs and the whole run silently no-ops.
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0: the first pnpm call fetches the pinned
# pnpm, and nobody is there to answer corepack's prompt.
run_in() {
  local dir="$1"
  shift
  sudo -u "$RUN_USER" -H XDG_RUNTIME_DIR="/run/user/${RUN_UID}" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    bash -lc "cd '$dir' && $*"
}
run_as() { run_in "$INSTALL_DIR" "$@"; }
for d in "$SRC_DIR" "$INSTALL_DIR"; do
  [ -d "$d" ] || install -d -o "$RUN_USER" -g "$RUN_USER" "$d"
done

if [ ! -d "$SRC_DIR/.git" ]; then
  log "cloning $REPO_URL ($REPO_BRANCH)…"
  run_in "$SRC_DIR" "git clone --quiet --branch '$REPO_BRANCH' --depth 1 '$REPO_URL' ."
else
  log "updating $SRC_DIR to $REPO_URL ($REPO_BRANCH)…"
  run_in "$SRC_DIR" "git fetch --quiet --depth 1 '$REPO_URL' '$REPO_BRANCH' && git checkout --quiet --force FETCH_HEAD"
fi

# A checkout at INSTALL_DIR that this repo's installer did not compose (an
# install from the retired single-branch fork, say) must not be composed over:
# the patches would land on the wrong base. The seam remote is the first thing
# a compose adds, so its absence marks a foreign tree.
if [ -d "$INSTALL_DIR/.git" ] && ! run_as "git remote get-url nanoclaw-webchat-seam >/dev/null 2>&1"; then
  die "$INSTALL_DIR holds a checkout this installer did not compose. Move it aside, or migrate it: bash $SRC_DIR/scripts/migrate-from-fork.sh $INSTALL_DIR"
fi

log "composing NanoClaw + webchat into $INSTALL_DIR (deps + build — several minutes)…"
# The agent image is left to setup:auto below, so it is built once, not twice.
# Compose-source overrides (a mirror of NanoClaw or of the seam) pass through.
COMPOSE_ENV="SKIP_CONTAINER_BUILD=1"
for v in NANOCLAW_WEBCHAT_BASE_REPO NANOCLAW_WEBCHAT_SEAM_REPO NANOCLAW_WEBCHAT_SEAM_BRANCH NANOCLAW_ALLOW_NODE_MISMATCH; do
  [ -n "${!v:-}" ] && COMPOSE_ENV="$COMPOSE_ENV $v='${!v}'"
done
run_in "$SRC_DIR" "$COMPOSE_ENV bash ./install.sh --dir '$INSTALL_DIR' </dev/null" \
  || die "compose failed — see the output above"

# ── 6. setup:auto — deps/OneCLI/agent-image/service, NO interactive steps ────
# Skips: auth (wizard mints creds), channel + first-chat (wizard makes the first
# agent), cli-agent (no terminal agent on a headless box), timezone (UTC default;
# clack's confirm needs a TTY cloud-init doesn't have).
# The portal offers (Echo's hardened image, Slack) are browser questions a
# headless run cannot answer: the prompt cancels on /dev/null and setup:auto
# exits 0 part-way, before the service step. Settle the image as the local
# build unless the operator already chose, and skip both offers.
install -m 600 -o "$RUN_USER" -g "$RUN_USER" /dev/null "$INSTALL_DIR/.env.tmp"
[ -f "$INSTALL_DIR/.env" ] && cat "$INSTALL_DIR/.env" >"$INSTALL_DIR/.env.tmp"
grep -q '^NANOCLAW_HARDENED_IMAGE=' "$INSTALL_DIR/.env.tmp" || echo 'NANOCLAW_HARDENED_IMAGE=false' >>"$INSTALL_DIR/.env.tmp"
mv "$INSTALL_DIR/.env.tmp" "$INSTALL_DIR/.env"
log "running setup:auto (deps, OneCLI, agent image, service)…"
run_as "NANOCLAW_BOOTSTRAPPED=1 \
        NANOCLAW_DISPLAY_NAME='$DISPLAY_NAME' \
        NANOCLAW_SKIP='auth,channel,first-chat,cli-agent,timezone,echo-reminder,slack-reminder' \
        NANOCLAW_HEADLESS=1 pnpm run setup:auto </dev/null" \
  || die "setup:auto failed — see the guest logs (logs/setup.log). If it hung on a prompt, that's the headless-TTY risk noted in the README."

# ── 7. Seed the webchat .env (the wizard entry point) ───────────────────────
# 0.0.0.0 so it's reachable from the LAN; a bearer token because a LAN-exposed
# assistant must not be open. First browser login auto-becomes owner.
#
# Re-runs keep what is there. Rotating the token would lock out every existing
# login, and host/Tailscale may have been changed in Settings since, so on an
# existing .env those are only filled in when missing.
ENV_FILE="$INSTALL_DIR/.env"
set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >>"$ENV_FILE"
  fi
}
get_env() { grep "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
default_env() { grep -q "^$1=" "$ENV_FILE" 2>/dev/null || echo "$1=$2" >>"$ENV_FILE"; }
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
FIRST_RUN=1
grep -q '^WEBCHAT_ENABLED=' "$ENV_FILE" && FIRST_RUN=0
log "enabling webchat…"
set_env WEBCHAT_ENABLED true
default_env WEBCHAT_HOST 0.0.0.0
if [ "$WEBCHAT_PORT_SET" = 1 ]; then set_env WEBCHAT_PORT "$WEBCHAT_PORT"; else default_env WEBCHAT_PORT "$WEBCHAT_PORT"; fi
# Enable Tailscale identity auth up front so the tailnet flow needs no config:
# reach this over your tailnet and the first Tailscale login becomes owner (the
# wizard's "I'll use Tailscale" opt-in also promotes it if you signed in with the
# token first), after which the bearer token can be retired from Settings.
# Harmless when Tailscale isn't used — the bearer token is checked first, so
# token/LAN access is unaffected; it only logs one boot notice until Tailscale is
# present. First run only: a later run must not undo turning it off.
[ "$FIRST_RUN" = 1 ] && default_env WEBCHAT_TAILSCALE true
# A token only when there is none — and, on a re-run, only when nothing else
# authenticates (a token retired in favour of Tailscale stays retired).
if [ -z "$(get_env WEBCHAT_TOKEN)" ]; then
  if [ "$FIRST_RUN" = 1 ] || { [ "$(get_env WEBCHAT_TAILSCALE)" != true ] && [ -z "$(get_env WEBCHAT_TRUSTED_PROXY_IPS)" ]; }; then
    set_env WEBCHAT_TOKEN "$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
  fi
fi

# Timezone for agent time-awareness. The host reads TZ from .env and sets it on
# the agent container, so `TZ=<iana>` here is all that's needed — this is the
# headless equivalent of setup:auto's (skipped, TTY-bound) timezone step. Prefer
# the helper's prompt (NANOCLAW_TZ); else the guest's own zone if it's been set
# to something real; else leave it (the agent defaults to UTC).
TZ_VALUE="${NANOCLAW_TZ:-}"
if [ -z "$TZ_VALUE" ]; then
  sys_tz=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo "")
  case "$sys_tz" in "" | UTC | Etc/UTC) : ;; *) TZ_VALUE="$sys_tz" ;; esac
fi
if [ -n "$TZ_VALUE" ] && [ -f "/usr/share/zoneinfo/$TZ_VALUE" ]; then
  # An explicit NANOCLAW_TZ replaces the value; the guest's zone only fills a gap.
  if [ -n "${NANOCLAW_TZ:-}" ]; then set_env TZ "$TZ_VALUE"; else default_env TZ "$TZ_VALUE"; fi
  # Match the guest system zone too, so logs/cron read local.
  timedatectl set-timezone "$TZ_VALUE" 2>/dev/null ||
    { ln -sf "/usr/share/zoneinfo/$TZ_VALUE" /etc/localtime && echo "$TZ_VALUE" >/etc/timezone; } 2>/dev/null || true
  log "timezone: $TZ_VALUE"
elif [ -n "$TZ_VALUE" ]; then
  log "warn: ignoring unknown timezone '$TZ_VALUE' — agent will default to UTC"
fi

chown "$RUN_USER:$RUN_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ── 8. Start the service so the webchat env takes effect ────────────────────
# setup:auto installed + enabled a per-user unit named nanoclaw-v2-<slug> (the
# slug is install-path-derived, so we can't hardcode it). Discover it and
# (re)start it so it picks up the webchat .env just written — `restart` also
# starts a stopped unit.
log "starting the service…"
UNIT="$(run_as "systemctl --user list-unit-files --no-legend 'nanoclaw-v2-*.service' 2>/dev/null | grep -oE 'nanoclaw-v2-[^ ]+\.service' | head -n1")"
UNIT="${UNIT//[$'\r\n ']/}"
[ -n "$UNIT" ] || die "no nanoclaw-v2-*.service unit — setup:auto stopped before its service step. See $INSTALL_DIR/logs/setup.log"
run_as "systemctl --user restart '$UNIT'" \
  || die "could not start $UNIT — inspect: sudo -u $RUN_USER XDG_RUNTIME_DIR=/run/user/$RUN_UID systemctl --user status '$UNIT'"

# Print the URL only once the server answers. The unit may first wait up to
# 60s for the OneCLI gateway, hence the budget.
PORT_OUT="$(get_env WEBCHAT_PORT)"
log "waiting for /health on :${PORT_OUT:-$WEBCHAT_PORT}…"
if ! node -e '
  const url = process.argv[1], until = Date.now() + 150_000;
  (async () => {
    while (Date.now() < until) {
      try { if ((await fetch(url)).ok) process.exit(0); } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    process.exit(1);
  })();' "http://127.0.0.1:${PORT_OUT:-$WEBCHAT_PORT}/health"; then
  run_as "journalctl --user -u '$UNIT' -n 30 --no-pager" >&2 || true
  die "NanoClaw did not come up (no answer on :${PORT_OUT:-$WEBCHAT_PORT}/health)"
fi

# ── 9. Done — print the URL + token ─────────────────────────────────────────
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN_OUT="$(get_env WEBCHAT_TOKEN)"
cat <<EOF

================================================================
 NanoClaw is up. Finish setup in your browser:

   URL:    http://${IP:-<guest-ip>}:${PORT_OUT:-$WEBCHAT_PORT}
   Token:  ${TOKEN_OUT:-(none — sign in with Tailscale)}

 First login becomes the owner and the setup wizard opens automatically —
 pick Claude (sign in), or install a local model right there. No terminal
 auth needed.
================================================================
EOF
