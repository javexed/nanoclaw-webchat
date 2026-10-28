#!/usr/bin/env bash
# Host rules for agent workloads (src/modules/workloads). Once per host, as root.
#
# Docker's --internal networks drop traffic FORWARDED off the network, but not
# traffic addressed to this host: from a workload container, every service
# listening on the host (the credential gateway, webchat, a model server, the
# egress filter) answers at the network's gateway address. These rules drop
# new connections that arrive on a workload bridge (every one is named ncw…)
# or come from the workload range (198.18.0.0/15), IPv4 and IPv6. Replies to
# connections the host opened (NanoClaw reaching a workload's service) still
# pass.
#
# NanoClaw checks for this before it runs any workload: its preflight starts a
# throwaway container on a workload-shaped network and refuses workloads when
# that container reaches the host.
#
# The publishing routes' edge networks (bridges named nct…, one per install)
# hold the Tailscale sidecars and the Cloudflare connector. A new connection
# from one may reach exactly one thing on this host: the app gateway's port
# on the edge address (--gateway ADDR:PORT, NANOCLAW_WORKLOAD_GATEWAY_BIND and
# _PORT). Every other new connection to this host is dropped, and so is
# forwarding from an edge network into the workload range, private and
# link-local ranges and the tailnet's own range: a sidecar reaches Tailscale's
# servers, the connector Cloudflare's edge, and neither reaches anything of
# this host or its LAN. Without --gateway the edge networks reach nothing here.
#
#   sudo deploy/workloads-host-rules.sh [--gateway ADDR:PORT]                 # add (idempotent)
#   sudo deploy/workloads-host-rules.sh [--gateway ADDR:PORT] --install-unit  # add, and re-add at every boot
#   sudo deploy/workloads-host-rules.sh [--gateway ADDR:PORT] --check         # exit 0 when present
#   sudo deploy/workloads-host-rules.sh --remove                              # take them out again
set -euo pipefail

CHAIN=NANOCLAW-WORKLOADS
IFACE='ncw+'
RANGE4='198.18.0.0/15'
EDGE_CHAIN=NANOCLAW-TSEDGE
EDGE_FWD=NANOCLAW-TSEDGE-FWD
EDGE_IFACE='nct+'
# Where a sidecar's traffic may not be forwarded: workloads, private and
# link-local ranges (the LAN, other Docker networks), the tailnet (CGNAT).
EDGE_NO_FWD4='198.18.0.0/15 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10'
UNIT=nanoclaw-workloads-firewall.service
SBIN=/usr/local/sbin/nanoclaw-workloads-firewall

GATEWAY=''
ACTION=''
while [ $# -gt 0 ]; do
  case "$1" in
    --gateway)
      GATEWAY="${2:-}"
      shift 2
      ;;
    --gateway=*)
      GATEWAY="${1#--gateway=}"
      shift
      ;;
    --remove | --check | --install-unit)
      ACTION="$1"
      shift
      ;;
    *)
      echo "usage: $0 [--gateway ADDR:PORT] [--install-unit | --check | --remove]" >&2
      exit 2
      ;;
  esac
done
GW_ADDR=''
GW_PORT=''
if [ -n "$GATEWAY" ]; then
  if [[ "$GATEWAY" =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}):([0-9]{1,5})$ ]]; then
    GW_ADDR="${BASH_REMATCH[1]}"
    GW_PORT="${BASH_REMATCH[2]}"
  else
    echo "--gateway must be ADDR:PORT, e.g. 198.51.100.1:8470" >&2
    exit 2
  fi
fi

[ "$(id -u)" = 0 ] || { echo "run as root (sudo $0 $*)" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }
have iptables || { echo "iptables is not installed" >&2; exit 1; }

# The jumps from INPUT into the chain, per family.
jumps() {
  local ipt="$1"
  echo "-i $IFACE -j $CHAIN"
  [ "$ipt" = iptables ] && echo "-s $RANGE4 -j $CHAIN"
  return 0
}

# The edge chain's rules, in order, per family.
edge_rules() {
  local ipt="$1"
  echo "-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  [ "$ipt" = iptables ] && [ -n "$GW_ADDR" ] && echo "-d $GW_ADDR -p tcp --dport $GW_PORT -j ACCEPT"
  echo "-j DROP"
}

edge_fwd_rules() {
  local ipt="$1" r
  if [ "$ipt" = iptables ]; then
    for r in $EDGE_NO_FWD4; do echo "-d $r -j DROP"; done
    echo "-o $IFACE -j DROP"
  else
    # Edge networks are IPv4-only: nothing of theirs is forwarded over IPv6.
    echo "-j DROP"
  fi
}

fill() {
  local ipt="$1" chain="$2" gen="$3" rule
  "$ipt" -N "$chain" 2>/dev/null || "$ipt" -F "$chain"
  while read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    "$ipt" -A "$chain" $rule
  done < <("$gen" "$ipt")
}

add() {
  local ipt="$1"
  "$ipt" -N "$CHAIN" 2>/dev/null || "$ipt" -F "$CHAIN"
  "$ipt" -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "$ipt" -A "$CHAIN" -j DROP
  while read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    "$ipt" -C INPUT $rule 2>/dev/null || "$ipt" -I INPUT 1 $rule
  done < <(jumps "$ipt")
  # The edge: the gateway's port is accepted outright (a firewall further
  # down INPUT may drop what it does not know), everything else new dropped.
  fill "$ipt" "$EDGE_CHAIN" edge_rules
  "$ipt" -C INPUT -i "$EDGE_IFACE" -j "$EDGE_CHAIN" 2>/dev/null || "$ipt" -I INPUT 1 -i "$EDGE_IFACE" -j "$EDGE_CHAIN"
  fill "$ipt" "$EDGE_FWD" edge_fwd_rules
  "$ipt" -C FORWARD -i "$EDGE_IFACE" -j "$EDGE_FWD" 2>/dev/null || "$ipt" -I FORWARD 1 -i "$EDGE_IFACE" -j "$EDGE_FWD"
}

remove() {
  local ipt="$1" rule
  while read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    while "$ipt" -C INPUT $rule 2>/dev/null; do "$ipt" -D INPUT $rule; done
  done < <(jumps "$ipt")
  "$ipt" -F "$CHAIN" 2>/dev/null || true
  "$ipt" -X "$CHAIN" 2>/dev/null || true
  while "$ipt" -C INPUT -i "$EDGE_IFACE" -j "$EDGE_CHAIN" 2>/dev/null; do
    "$ipt" -D INPUT -i "$EDGE_IFACE" -j "$EDGE_CHAIN"
  done
  while "$ipt" -C FORWARD -i "$EDGE_IFACE" -j "$EDGE_FWD" 2>/dev/null; do
    "$ipt" -D FORWARD -i "$EDGE_IFACE" -j "$EDGE_FWD"
  done
  local c
  for c in "$EDGE_CHAIN" "$EDGE_FWD"; do
    "$ipt" -F "$c" 2>/dev/null || true
    "$ipt" -X "$c" 2>/dev/null || true
  done
}

check() {
  local ipt="$1"
  "$ipt" -S "$CHAIN" 2>/dev/null | grep -q -- '-j DROP' || return 1
  while read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    "$ipt" -C INPUT $rule 2>/dev/null || return 1
  done < <(jumps "$ipt")
  "$ipt" -C INPUT -i "$EDGE_IFACE" -j "$EDGE_CHAIN" 2>/dev/null || return 1
  "$ipt" -C FORWARD -i "$EDGE_IFACE" -j "$EDGE_FWD" 2>/dev/null || return 1
  while read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    "$ipt" -C "$EDGE_CHAIN" $rule 2>/dev/null || return 1
  done < <(edge_rules "$ipt")
  while read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    "$ipt" -C "$EDGE_FWD" $rule 2>/dev/null || return 1
  done < <(edge_fwd_rules "$ipt")
}

families() {
  echo iptables
  have ip6tables && echo ip6tables
  return 0
}

install_unit() {
  # The unit runs a root-owned copy: never a script in the install folder,
  # which NanoClaw's own user can change.
  install -m 0755 -o root -g root "$0" "$SBIN"
  cat >"/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=NanoClaw: keep agent workloads off this host's own services
After=network-pre.target
Before=docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$SBIN${GATEWAY:+ --gateway $GATEWAY}
ExecStop=$SBIN --remove

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null
  echo "installed $UNIT (re-adds the rules at boot)"
}

case "$ACTION" in
  --remove)
    for f in $(families); do remove "$f"; done
    echo "workload host rules removed"
    ;;
  --check)
    for f in $(families); do check "$f" || { echo "missing ($f)"; exit 1; }; done
    echo "present"
    ;;
  --install-unit)
    for f in $(families); do add "$f"; done
    install_unit
    echo "workload host rules in place"
    ;;
  "")
    for f in $(families); do add "$f"; done
    echo "workload host rules in place (not kept across reboots: add --install-unit)"
    ;;
esac
