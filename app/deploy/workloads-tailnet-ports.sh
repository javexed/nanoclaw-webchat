#!/usr/bin/env bash
# Tailnet ports for published apps: the "port" publishing route
# (src/modules/workloads/port, docs/webchat/workloads.md "Tailnet ports
# route"). Once per host, as root or Tailscale's operator.
#
# Points each port in the range, on this machine's tailnet name, at the app
# gateway's listener for that port on loopback:
#
#   https://<node>.<tailnet>.ts.net:9001  →  http://127.0.0.1:9001
#
# Tailnet only: a port that is on Funnel is refused, never served. A port
# that already serves something else is left alone and reported. NanoClaw
# cannot change Tailscale's serve config itself; it reads it and hands each
# published app one of these ports.
#
#   sudo deploy/workloads-tailnet-ports.sh [--ports 9001-9010]            # add (idempotent)
#   sudo deploy/workloads-tailnet-ports.sh [--ports 9001-9010] --check    # exit 0 when all are set up
#   sudo deploy/workloads-tailnet-ports.sh [--ports 9001-9010] --remove   # take them out again
#
# The range must match NANOCLAW_WORKLOAD_PORTS (Admin → Publishing →
# Tailnet ports writes 9001-9010).
set -euo pipefail

PORTS='9001-9010'
ACTION='add'
while [ $# -gt 0 ]; do
  case "$1" in
    --ports)
      PORTS="${2:-}"
      shift 2
      ;;
    --ports=*)
      PORTS="${1#--ports=}"
      shift
      ;;
    --check | --remove)
      ACTION="${1#--}"
      shift
      ;;
    -h | --help)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! [[ "$PORTS" =~ ^([0-9]{4,5})(-([0-9]{4,5}))?$ ]]; then
  echo "--ports must be one port or a range, e.g. 9001-9010" >&2
  exit 2
fi
LO=$((10#${BASH_REMATCH[1]}))
HI=$((10#${BASH_REMATCH[3]:-${BASH_REMATCH[1]}}))
if [ "$LO" -lt 1024 ] || [ "$HI" -gt 65535 ] || [ "$HI" -lt "$LO" ] || [ $((HI - LO + 1)) -gt 50 ]; then
  echo "--ports must be at most 50 ports from 1024 to 65535" >&2
  exit 2
fi

command -v tailscale >/dev/null || { echo "tailscale is not installed on this host" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is needed to read Tailscale's status" >&2; exit 1; }

DNS=$(tailscale status --json | python3 -c '
import json, sys
s = json.load(sys.stdin)
print((s.get("Self") or {}).get("DNSName", "").rstrip(".") if s.get("BackendState") == "Running" else "")
')
if [ -z "$DNS" ]; then
  echo "Tailscale is not running or not logged in on this host" >&2
  exit 1
fi

# What port P serves now: "none", "ours", "funnel" or "other".
served() {
  tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
p, dns = sys.argv[1], sys.argv[2]
raw = sys.stdin.read().strip()
c = json.loads(raw) if raw else {}
key = f"{dns}:{p}"
web, tcp = (c.get("Web") or {}).get(key), (c.get("TCP") or {}).get(p)
if not web and not tcp:
    print("none")
elif (c.get("AllowFunnel") or {}).get(key):
    print("funnel")
else:
    h = list(((web or {}).get("Handlers") or {}).items())
    ok = (tcp or {}).get("HTTPS") and len(h) == 1 and h[0][0] == "/" \
        and (h[0][1].get("Proxy") or "").rstrip("/") == f"http://127.0.0.1:{p}"
    print("ours" if ok else "other")
' "$1" "$DNS"
}

fail=0
for ((p = LO; p <= HI; p++)); do
  now=$(served "$p")
  case "$ACTION:$now" in
    add:ours | check:ours) echo "ok       https://$DNS:$p" ;;
    add:none)
      tailscale serve --bg --yes --https="$p" "http://127.0.0.1:$p" >/dev/null
      [ "$(served "$p")" = ours ] && echo "added    https://$DNS:$p" || { echo "FAILED   port $p" >&2; fail=1; }
      ;;
    remove:ours)
      tailscale serve --https="$p" off >/dev/null
      echo "removed  https://$DNS:$p"
      ;;
    remove:none) ;;
    *:funnel) echo "refused  port $p is on Funnel (open to the internet): turn Funnel off for it first" >&2; fail=1 ;;
    remove:other) echo "skipped  port $p serves something else; left alone" ;;
    *:other) echo "skipped  port $p already serves something else; left alone" >&2; fail=1 ;;
    check:none) echo "missing  port $p" >&2; fail=1 ;;
  esac
done
exit "$fail"
