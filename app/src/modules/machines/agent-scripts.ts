/**
 * What runs on a machine (docs/webchat/scaling.md). Plain sh + curl + openssl,
 * which every Linux VM has, so joining installs nothing it did not get from
 * NanoClaw (a worker needs Docker with the Compose plugin already there; it
 * says so when it is missing). install.sh is served by the machine listener with central's
 * address and key pin filled in; it generates the machine's key locally,
 * joins with the one-time token, and sets up a systemd timer that runs
 * report.sh every minute: a health report, and a certificate renewal when
 * less than 12 hours are left. A revoked machine is told so on its next
 * report and switches the timer off.
 *
 * A machine with the worker role also gets the worker service (worker-main.ts
 * on the machine's Node), which holds the lasting link, and the workload host
 * rules (deploy/workloads-host-rules.sh, the same as central's, with their
 * boot unit); the timer stays as a fallback report and renews the
 * certificate.
 */

import { createHash } from 'crypto';

export const AGENT_VERSION = '1';

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** sha256 of the installer as the listener serves it (listener.ts), so the command can check what it got. */
export const installScriptHash = (host: string, port: number, pin: string): string =>
  createHash('sha256')
    .update(installScript(host, port, pin))
    .digest('hex');

/**
 * Fetch install.sh into a fresh private folder ($D, made by mktemp -d: 0700,
 * so no other user on the machine can swap the file), check it is exactly
 * the installer NanoClaw serves, or say which inbound rule is missing.
 */
function fetchInstaller(host: string, port: number, pin: string): string {
  const url = `https://${host}:${port}`;
  const curl = `curl -fsS --connect-timeout 5 -k --pinnedpubkey ${shQuote(`sha256//${pin}`)}`;
  return (
    `umask 077 && D=$(mktemp -d) && ` +
    `{ ${curl} ${url}/install.sh -o "$D/install.sh" || ` +
    `{ echo "Can't reach NanoClaw at ${host}:${port}. Add an inbound rule on its network security group: ` +
    `source $(hostname -I | cut -d' ' -f1), destination ${host}, TCP ${port}"; false; }; } && ` +
    `{ echo ${installScriptHash(host, port, pin)}'  '"$D/install.sh" | sha256sum -c --status || ` +
    `{ echo "The installer did not arrive intact."; false; }; }`
  );
}

/** For a machine that joined before the worker service existed: run once, as root, on the machine. */
export function workerUpgradeCommand(): string {
  return (
    `sudo sh -c '. /etc/nanoclaw-machine/config && curl -fsS -k --pinnedpubkey "sha256//$PIN" ` +
    `--cert /etc/nanoclaw-machine/cert.pem --key /etc/nanoclaw-machine/key.pem "https://$HOST:$PORT/worker/install.sh" | sh'`
  );
}

/**
 * The one line an admin runs on the machine. The token goes into a file in
 * the private folder (printf is a shell builtin: it never shows in `ps`) and
 * the installer reads it from there; the folder is removed afterwards.
 */
export function installCommand(host: string, port: number, pin: string, token: string): string {
  return (
    `${fetchInstaller(host, port, pin)} && printf '%s' ${shQuote(token)} > "$D/token" && ` +
    `sudo NC_TOKEN_FILE="$D/token" sh "$D/install.sh"; rc=$?; rm -rf "$D"; [ "$rc" = 0 ]`
  );
}

/**
 * The same, run by NanoClaw over SSH (ssh-join.ts). The token comes as the
 * first line of stdin (read before anything else runs, never in argv, which
 * other users see), then the sudo password. 'password': sudo reads the
 * password from stdin (`-S -p ''`), never argv; 'none': `sudo -n`, which
 * fails with "a password is required" rather than waiting. Either way the
 * installer itself gets /dev/null as stdin, so nothing after sudo can read it.
 */
export function sshInstallCommand(host: string, port: number, pin: string, sudo: 'password' | 'none'): string {
  const inner = `exec </dev/null; NC_TOKEN_FILE="$1" exec sh "$2"`;
  const su = sudo === 'password' ? "sudo -S -p ''" : 'sudo -n';
  return (
    `IFS= read -r T; ${fetchInstaller(host, port, pin)} && printf '%s' "$T" > "$D/token" && unset T && ` +
    `${su} sh -c ${shQuote(inner)} sh "$D/token" "$D/install.sh"; rc=$?; rm -rf "$D"; [ "$rc" = 0 ]`
  );
}

const REPORT = `#!/bin/sh
# NanoClaw machine agent: health report + certificate renewal, every minute.
set -u
DIR=/etc/nanoclaw-machine
. "$DIR/config"
[ -f "$DIR/revoked" ] && exit 0
TLS="-sS --max-time 20 -k --pinnedpubkey sha256//$PIN --cert $DIR/cert.pem --key $DIR/key.pem"
URL="https://$HOST:$PORT"
NOW=$(date +%s)
CPUS=$(nproc)
MT=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
MA=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
MU=$((MT - MA))
# NanoClaw's own use: the nanoclaw*.slice cgroups (workloads run there).
NCM=0; NCU=0
for s in /sys/fs/cgroup/nanoclaw*.slice; do
  [ -d "$s" ] || continue
  [ -f "$s/memory.current" ] && NCM=$((NCM + $(cat "$s/memory.current") / 1048576))
  [ -f "$s/cpu.stat" ] && NCU=$((NCU + $(awk '/^usage_usec/{print $2}' "$s/cpu.stat")))
done
set -- $(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat)
TOT=$1; IDLE=$2
CPU_USED=0; CPU_NC=0
if [ -f "$DIR/state" ]; then
  . "$DIR/state"
  DT=$((TOT - P_TOT)); DI=$((IDLE - P_IDLE)); DS=$((NOW - P_NOW))
  [ "$DT" -gt 0 ] && CPU_USED=$(awk -v t="$DT" -v i="$DI" -v c="$CPUS" 'BEGIN{printf "%.2f", (t-i)/t*c}')
  [ "$DS" -gt 0 ] && CPU_NC=$(awk -v u=$((NCU - P_NCU)) -v s="$DS" 'BEGIN{v=u/(s*1000000); if(v<0)v=0; printf "%.2f", v}')
fi
printf 'P_TOT=%s\\nP_IDLE=%s\\nP_NOW=%s\\nP_NCU=%s\\n' "$TOT" "$IDLE" "$NOW" "$NCU" > "$DIR/state"
set -- $(df -BG --output=size,avail / | tail -1 | tr -dc '0-9 ')
LOAD=$(cut -d' ' -f1 /proc/loadavg)
BODY=$(printf '{"cpus":%s,"memTotalMb":%s,"memUsedMb":%s,"memNanoclawMb":%s,"cpuUsed":%s,"cpuNanoclaw":%s,"diskTotalGb":%s,"diskFreeGb":%s,"load1":%s,"agentVersion":"${AGENT_VERSION}"}' \\
  "$CPUS" "$MT" "$MU" "$NCM" "$CPU_USED" "$CPU_NC" "$1" "$2" "$LOAD")
CODE=$(curl $TLS -o "$DIR/reply" -w '%{http_code}' -H 'content-type: application/json' --data "$BODY" "$URL/report")
if [ "$CODE" = 403 ]; then
  echo "NanoClaw revoked this machine; stopping the agent."
  touch "$DIR/revoked"
  systemctl disable --now nanoclaw-machine.timer >/dev/null 2>&1
  exit 0
fi
if grep -q renew "$DIR/reply" 2>/dev/null || ! openssl x509 -checkend 43200 -noout -in "$DIR/cert.pem" >/dev/null 2>&1; then
  openssl req -new -key "$DIR/key.pem" -subj /CN=nanoclaw-machine -out "$DIR/req.csr" 2>/dev/null
  if curl $TLS -o "$DIR/cert.new" --data-binary @"$DIR/req.csr" -H 'content-type: text/plain' "$URL/renew" \\
    && grep -q 'BEGIN CERTIFICATE' "$DIR/cert.new"; then
    mv "$DIR/cert.new" "$DIR/cert.pem"
  fi
fi
`;

const WORKER_UNIT = `[Unit]
Description=NanoClaw worker service (lasting link to NanoClaw)
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env node /usr/local/lib/nanoclaw-machine/worker/worker-main.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`;

/** The files worker-install.sh fetches, each checked against the sha256 central computed. */
export const WORKER_FETCHED = ['mux.js', 'worker-main.js', 'workloads-host-rules.sh'] as const;
export type WorkerHashes = Partial<Record<(typeof WORKER_FETCHED)[number], string>>;

/** Where the host rules land on a worker; the owner runs this to put them back. */
export const WORKER_HOST_RULES = '/usr/local/lib/nanoclaw-machine/worker/workloads-host-rules.sh';
export const workerHostRulesCommand = (): string => `sudo bash ${WORKER_HOST_RULES} --install-unit`;

/**
 * worker-install.sh, served to a joined machine (its certificate) and run as
 * root: Node 18+ if missing (the distribution's package), iptables if
 * missing, the worker's files (each hash-checked), the workload host rules
 * with their boot unit, and the worker's systemd unit. Safe to run again: it
 * refreshes the files and the rules.
 */
export function workerInstallScript(host: string, port: number, pin: string, hashes: WorkerHashes = {}): string {
  const fetch = WORKER_FETCHED.map((f) => {
    const h = /^[0-9a-f]{64}$/.test(hashes[f] ?? '') ? hashes[f] : '';
    return `fetch ${f} ${h || 'missing'}`;
  }).join('\n');
  return `#!/bin/sh
# NanoClaw worker service installer (${host}:${port}).
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
LOCK=/run/nanoclaw-machine-install.lock
mkdir "$LOCK" 2>/dev/null || { echo "Another NanoClaw install is running on this machine ($LOCK)."; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
# put FILE MODE: stdin to FILE, whole or not at all, its mode set before any content is in it.
put() { t=$(mktemp "$1.XXXXXX") && chmod "$2" "$t" && cat > "$t" && mv -f "$t" "$1"; }
DIR=/etc/nanoclaw-machine
LIB=/usr/local/lib/nanoclaw-machine/worker
TLS="-fsS --max-time 60 -k --pinnedpubkey sha256//${pin} --cert $DIR/cert.pem --key $DIR/key.pem"
URL=${shQuote(`https://${host}:${port}`)}
major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null || [ "$(major)" -lt 18 ]; then
  echo "Installing Node.js (the worker service runs on it)."
  if command -v apt-get >/dev/null; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q nodejs
  else echo "Install Node.js 18 or later, then run this again."; exit 1
  fi
fi
[ "$(major)" -ge 18 ] || { echo "Node.js 18 or later is needed (found $(node -v 2>/dev/null))."; exit 1; }
command -v docker >/dev/null && docker compose version >/dev/null 2>&1 \
  || { echo "Docker with the Compose plugin is needed: https://docs.docker.com/engine/install/"; exit 1; }
mkdir -p "$LIB" /var/lib/nanoclaw-worker
chmod 700 /var/lib/nanoclaw-worker
# Each file is checked against the hash NanoClaw computed for it before it is used.
fetch() {
  [ "$2" != missing ] || { echo "NanoClaw could not serve $1; update NanoClaw and run this again."; exit 1; }
  curl $TLS -o "$LIB/$1.new" "$URL/worker/$1"
  echo "$2  $LIB/$1.new" | sha256sum -c --status || { rm -f "$LIB/$1.new"; echo "$1 did not arrive intact."; exit 1; }
  mv "$LIB/$1.new" "$LIB/$1"
}
${fetch}
printf '{"type":"module"}\n' | put "$LIB/package.json" 600
# Workload host rules: a workload container must not reach this machine's own
# services through its network's gateway address. The worker checks they work
# and takes no workloads until they do.
if ! command -v iptables >/dev/null; then
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q iptables
  fi
fi
bash "$LIB/workloads-host-rules.sh" --install-unit \
  || echo "The workload host rules did not install; this machine takes no workloads until they do: ${workerHostRulesCommand()}"
put /etc/systemd/system/nanoclaw-worker.service 644 <<'NC_WUNIT'
${WORKER_UNIT}NC_WUNIT
systemctl daemon-reload
systemctl enable nanoclaw-worker.service >/dev/null
systemctl restart nanoclaw-worker.service
echo "NanoClaw worker service running."
`;
}

const UNIT = `[Unit]
Description=NanoClaw machine agent (health report, certificate renewal)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/lib/nanoclaw-machine/report.sh
`;

const TIMER = `[Unit]
Description=Run the NanoClaw machine agent every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
`;

/**
 * install.sh as served to a machine. The token comes from a file only root
 * and the admin can read (NC_TOKEN_FILE, installCommand), never argv or the
 * script. It is run as root, so: a private umask before anything is written,
 * one run at a time (a lock), every file written whole or not at all, and no
 * temporary file anywhere another user could reach. Docker is not installed
 * here (the worker service needs it and says so): this script runs nothing
 * fetched from anywhere but NanoClaw.
 */
export function installScript(host: string, port: number, pin: string): string {
  return `#!/bin/sh
# NanoClaw machine installer: joins this machine to NanoClaw at ${host}:${port}.
set -eu
umask 077
HOST=${shQuote(host)}
PORT=${shQuote(String(port))}
PIN=${shQuote(pin)}
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
TOKEN=""
if [ -n "\${NC_TOKEN_FILE:-}" ] && [ -f "$NC_TOKEN_FILE" ]; then TOKEN=$(cat "$NC_TOKEN_FILE"); rm -f "$NC_TOKEN_FILE"; fi
[ -n "$TOKEN" ] || { echo "No join token: use the command from NanoClaw's Add machine."; exit 1; }
for c in curl openssl systemctl; do command -v "$c" >/dev/null || { echo "Needs $c."; exit 1; }; done
LOCK=/run/nanoclaw-machine-install.lock
mkdir "$LOCK" 2>/dev/null || { echo "Another NanoClaw install is running on this machine ($LOCK)."; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
URL="https://$HOST:$PORT"
PINNED="-k --pinnedpubkey sha256//$PIN"
if ! curl -sS -o /dev/null --connect-timeout 5 $PINNED "$URL/healthz"; then
  echo "Can't reach NanoClaw at $HOST:$PORT. Add an inbound rule on its network security group:"
  echo "  source $(hostname -I | cut -d' ' -f1), destination $HOST, TCP $PORT"
  exit 1
fi
DIR=/etc/nanoclaw-machine
LIB=/usr/local/lib/nanoclaw-machine
mkdir -p "$DIR" "$LIB"
chmod 700 "$DIR"
# put FILE MODE: stdin to FILE, whole or not at all, its mode set before any content is in it.
put() { t=$(mktemp "$1.XXXXXX") && chmod "$2" "$t" && cat > "$t" && mv -f "$t" "$1"; }
# $DIR is root's alone (0700) and the umask is 077: these files are private from their first byte.
[ -f "$DIR/key.pem" ] || { openssl ecparam -name prime256v1 -genkey -noout -out "$DIR/key.pem.new" && mv -f "$DIR/key.pem.new" "$DIR/key.pem"; }
chmod 600 "$DIR/key.pem"
openssl req -new -key "$DIR/key.pem" -subj /CN=nanoclaw-machine -out "$DIR/req.csr"
CSR=$(base64 -w0 "$DIR/req.csr")
CPUS=$(nproc)
MEM=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
DISK=$(df -BG --output=size / | tail -1 | tr -dc '0-9')
NAME=$(hostname | tr -dc 'A-Za-z0-9._-')
OS=$( (. /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-linux}") | tr -dc 'A-Za-z0-9 ._()/-')
# The body (with the token) goes to curl on stdin, never in its arguments.
REPLY=$(printf '{"token":"%s","csr":"%s","facts":{"hostname":"%s","os":"%s","cpus":%s,"memTotalMb":%s,"diskTotalGb":%s}}' \\
  "$TOKEN" "$CSR" "$NAME" "$OS" "$CPUS" "$MEM" "$DISK" \\
  | curl -fsS --max-time 30 $PINNED -H 'content-type: application/json' --data-binary @- "$URL/enroll") || {
  echo "NanoClaw refused to add this machine (token used, expired or wrong)."; exit 1; }
TOKEN=""
ID=$(printf '%s\\n' "$REPLY" | sed -n 's/^id //p')
JOINED=$(printf '%s\\n' "$REPLY" | sed -n 's/^name //p')
printf '%s\\n' "$REPLY" | sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' | put "$DIR/cert.pem" 600
printf 'HOST=%s\\nPORT=%s\\nPIN=%s\\nID=%s\\n' "$HOST" "$PORT" "$PIN" "$ID" | put "$DIR/config" 600
rm -f "$DIR/revoked" "$DIR/state" "$DIR/req.csr"
put "$LIB/report.sh" 755 <<'NC_REPORT'
${REPORT}NC_REPORT
put /etc/systemd/system/nanoclaw-machine.service 644 <<'NC_UNIT'
${UNIT}NC_UNIT
put /etc/systemd/system/nanoclaw-machine.timer 644 <<'NC_TIMER'
${TIMER}NC_TIMER
systemctl daemon-reload
systemctl enable --now nanoclaw-machine.timer >/dev/null
"$LIB/report.sh" || true
echo "Joined NanoClaw as $JOINED."
ROLE=$(printf '%s\n' "$REPLY" | sed -n 's/^role //p')
if [ "$ROLE" = worker ]; then
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    echo "A worker needs Docker with the Compose plugin: install it (https://docs.docker.com/engine/install/), then run the worker command from NanoClaw's Machines page."
  else
    rmdir "$LOCK" 2>/dev/null || true
    curl -fsS --max-time 30 $PINNED --cert "$DIR/cert.pem" --key "$DIR/key.pem" -o "$DIR/worker-install.sh" "$URL/worker/install.sh" \
      && sh "$DIR/worker-install.sh" || echo "The worker service did not install; run the worker command from NanoClaw's Machines page."
  fi
fi
`;
}

export const reportScript = (): string => REPORT;
