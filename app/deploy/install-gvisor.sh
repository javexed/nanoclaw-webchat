#!/usr/bin/env bash
# gVisor (runsc) for confined workload builds (src/modules/workloads/builder.ts).
# Once per host, as a sudoer. Adds a Docker runtime; nothing uses it unless a
# container asks for --runtime=runsc. Docker is RELOADED (SIGHUP), not
# restarted: running containers are untouched. Then set
# NANOCLAW_WORKLOAD_CONFINED_BUILDS=1 in the install's .env and restart it.
set -euo pipefail
KEYRING=/usr/share/keyrings/gvisor-archive-keyring.gpg
# The helper image NanoClaw itself uses (src/modules/workloads/images.ts), for the smoke test.
TEST_IMAGE='alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f'
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor --yes -o "$KEYRING"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=$KEYRING] https://storage.googleapis.com/gvisor/releases release main" |
    sudo tee /etc/apt/sources.list.d/gvisor.list >/dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq runsc
fi
CONF=/etc/docker/daemon.json
if ! sudo test -f "$CONF" || ! sudo grep -q '"runsc"' "$CONF"; then
  sudo test -f "$CONF" && sudo cp "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"
  sudo python3 - "$CONF" <<'PY'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p)) if os.path.exists(p) else {}
d.setdefault('runtimes', {})['runsc'] = {'path': '/usr/bin/runsc'}
json.dump(d, open(p, 'w'), indent=2)
PY
  sudo systemctl reload docker
fi
docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' | grep -qw runsc && echo "runsc registered"
docker run --rm --runtime=runsc --network none "$TEST_IMAGE" uname -r
