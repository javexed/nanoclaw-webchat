#!/usr/bin/env bash
# deploy/onecli-private-ports.sh — keep a local OneCLI's management API and
# Postgres off the docker bridge, on every update.
#
# A fresh install binds them privately (add-onecli setup). An install made
# before that still has them on the bridge, where every container on the host
# reaches them, until `setup.ts --private-ports` runs once. This runs it, from
# the install root, as the last step of an update (install.sh, and
# webchat-deploy.sh for a tarball install). Idempotent: the compose file is
# rewritten and the stack recreated only on a change.
#
# Skipped, with nothing touched, when there is nothing to migrate or it is not
# safe to do unattended:
#   - not Linux (only Linux binds OneCLI to the bridge);
#   - no local OneCLI ($HOME/.onecli/docker-compose.yml), no onecli CLI, or no
#     add-onecli setup script in this tree;
#   - this install has no ONECLI_URL in .env yet (a first install's setup does
#     it), or its ONECLI_URL is not this host's OneCLI (a remote gateway);
#   - another NanoClaw install on this host (a systemd unit with another
#     working directory) still dials the API on the bridge: moving the API
#     would cut it off, so this prints the command to run in each instead;
#   - NANOCLAW_SKIP_ONECLI_PRIVATE_PORTS=1.
# A failed migration warns and exits 0: an update is not undone over it.
#
# ONECLI_URL may move to loopback; the caller restarts the service after.
set -uo pipefail

say() { echo "→ $*"; }
warn() { echo "  !! $*" >&2; }

[ "${NANOCLAW_SKIP_ONECLI_PRIVATE_PORTS:-}" = 1 ] && exit 0
[ "$(uname -s)" = Linux ] || exit 0

ONECLI_HOME="${HOME:-}/.onecli"
COMPOSE="$ONECLI_HOME/docker-compose.yml"
SETUP=.claude/skills/add-onecli/scripts/setup.ts
[ -f "$COMPOSE" ] || exit 0
[ -f "$SETUP" ] || exit 0
command -v onecli >/dev/null 2>&1 || [ -x "${HOME:-}/.local/bin/onecli" ] || exit 0
[ -f .env ] || exit 0

env_url() { grep '^ONECLI_URL=' "$1" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"'"'"; }
url_host() { printf '%s\n' "$1" | sed -E 's#^[a-z]+://##; s#[:/].*$##'; }

URL="$(env_url .env)"
[ -n "$URL" ] || exit 0
HOST="$(url_host "$URL")"
BIND="$(grep '^ONECLI_BIND_HOST=' "$ONECLI_HOME/.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
BRIDGE="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true)"
case "$HOST" in
  127.0.0.1 | localhost) ;;
  *)
    if [ "$HOST" != "${BIND:-}" ] && [ "$HOST" != "${BRIDGE:-}" ] && [ "$HOST" != 172.17.0.1 ]; then
      exit 0 # not this host's OneCLI
    fi
    ;;
esac

# Other installs on this host sharing the gateway, still on the bridge.
HERE="$(pwd -P)"
others=()
for scope in --system --user; do
  command -v systemctl >/dev/null 2>&1 || break
  while read -r unit; do
    [ -n "$unit" ] || continue
    dir="$(systemctl "$scope" show -p WorkingDirectory --value "$unit" 2>/dev/null || true)"
    [ -n "$dir" ] && [ -f "$dir/.env" ] || continue
    [ "$(cd "$dir" 2>/dev/null && pwd -P)" = "$HERE" ] && continue
    case "$(url_host "$(env_url "$dir/.env")")" in
      "" | 127.0.0.1 | localhost) ;;
      *) others+=("$dir") ;;
    esac
  done < <(systemctl "$scope" list-units --all --type=service --plain --no-legend 'nanoclaw*' 2>/dev/null | awk '{print $1}')
done
if [ "${#others[@]}" -gt 0 ]; then
  warn "OneCLI's API and database are still on the docker bridge, and other installs on this host dial it there:"
  printf '       %s\n' "${others[@]}" >&2
  warn "Run, in each install directory (this one too), then restart each service:"
  warn "  pnpm exec tsx $SETUP --private-ports"
  exit 0
fi

say "Keeping OneCLI's API and database off the docker bridge"
if pnpm exec tsx "$SETUP" --private-ports >/dev/null; then
  NEW="$(env_url .env)"
  [ "$NEW" = "$URL" ] || say "ONECLI_URL is now $NEW (restart the service to use it)"
else
  warn "could not make OneCLI's ports private; see logs/setup.log, then run: pnpm exec tsx $SETUP --private-ports"
fi
exit 0
