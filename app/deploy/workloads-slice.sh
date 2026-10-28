#!/usr/bin/env bash
# The systemd slice every agent workload container runs under: the ceiling on
# memory, CPU and tasks for ALL workloads of one NanoClaw install, whatever
# the agents' own quotas add up to. Once per host, as root.
#
#   sudo deploy/workloads-slice.sh --name nanoclaw-wl-<install>.slice --memory 8G [--cpus 4] [--tasks 8192]
#
# NanoClaw names the slice it expects in its preflight error (and in
# NANOCLAW_WORKLOAD_SLICE when set). Re-running changes the limits in place.
set -euo pipefail

NAME=''
MEMORY=''
CPUS=''
TASKS=8192
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --tasks) TASKS="$2"; shift 2 ;;
    *) echo "usage: $0 --name <slice> --memory <size, e.g. 8G> [--cpus N] [--tasks N]" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[[ "$NAME" =~ ^nanoclaw-wl-[A-Za-z0-9_-]+\.slice$ ]] || { echo "--name must be nanoclaw-wl-<install>.slice" >&2; exit 2; }
[[ "$MEMORY" =~ ^[0-9]+[KMGT]?$ ]] || { echo "--memory must be a size like 8G" >&2; exit 2; }
[[ "$TASKS" =~ ^[0-9]+$ ]] || { echo "--tasks must be a number" >&2; exit 2; }
if [ -n "$CPUS" ]; then
  [[ "$CPUS" =~ ^[0-9]+$ ]] || { echo "--cpus must be a whole number" >&2; exit 2; }
fi

FILE="/etc/systemd/system/$NAME"
{
  echo '[Unit]'
  echo 'Description=NanoClaw agent workloads'
  echo 'Before=slices.target'
  echo
  echo '[Slice]'
  echo "MemoryMax=$MEMORY"
  echo "MemorySwapMax=0"
  echo "TasksMax=$TASKS"
  [ -n "$CPUS" ] && echo "CPUQuota=$((CPUS * 100))%"
} >"$FILE"
chmod 0644 "$FILE"
systemctl daemon-reload
systemctl start "$NAME"
systemctl show "$NAME" -p LoadState -p MemoryMax -p TasksMax -p CPUQuotaPerSecUSec
