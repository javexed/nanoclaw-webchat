/**
 * What runs on a machine (Scaling design: joining). Plain sh + curl + openssl,
 * which every Linux VM has, so joining installs nothing but Docker (when it is
 * missing). install.sh is served by the machine listener with central's
 * address and key pin filled in; it generates the machine's key locally,
 * joins with the one-time token, and sets up a systemd timer that runs
 * report.sh every minute: a health report, and a certificate renewal when
 * less than 12 hours are left. A revoked machine is told so on its next
 * report and switches the timer off.
 *
 * Phase 3 replaces the timer with the worker service's lasting connection.
 */

export const AGENT_VERSION = '1';

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Fetch install.sh, or say which inbound rule is missing. */
function fetchInstaller(host: string, port: number, pin: string): string {
  const url = `https://${host}:${port}`;
  const curl = `curl -fsS --connect-timeout 5 -k --pinnedpubkey ${shQuote(`sha256//${pin}`)}`;
  return (
    `${curl} ${url}/install.sh -o /tmp/nanoclaw-machine.sh || ` +
    `{ echo "Can't reach NanoClaw at ${host}:${port}. Add an inbound rule on its network security group: ` +
    `source $(hostname -I | cut -d' ' -f1), destination ${host}, TCP ${port}"; false; }`
  );
}

/** The one line an admin runs on the machine. */
export function installCommand(host: string, port: number, pin: string, token: string): string {
  return `${fetchInstaller(host, port, pin)} && sudo NC_TOKEN=${shQuote(token)} sh /tmp/nanoclaw-machine.sh`;
}

/**
 * The same, run by NanoClaw over SSH (ssh-join.ts). 'password': sudo reads the
 * password from stdin (`-S -p ''`), never argv; 'none': `sudo -n`, which fails
 * with "a password is required" rather than waiting. Either way the installer
 * itself gets /dev/null as stdin, so nothing after sudo can read the password.
 */
export function sshInstallCommand(
  host: string,
  port: number,
  pin: string,
  token: string,
  sudo: 'password' | 'none',
): string {
  const inner = `exec </dev/null; NC_TOKEN=${shQuote(token)} exec sh /tmp/nanoclaw-machine.sh`;
  const su = sudo === 'password' ? "sudo -S -p ''" : 'sudo -n';
  return `${fetchInstaller(host, port, pin)} && ${su} sh -c ${shQuote(inner)}`;
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
# NanoClaw's own use: the nanoclaw*.slice cgroups (phase 3 runs its work there).
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

/** install.sh as served to a machine. The token comes from the environment, never the script. */
export function installScript(host: string, port: number, pin: string): string {
  return `#!/bin/sh
# NanoClaw machine installer: joins this machine to NanoClaw at ${host}:${port}.
set -eu
HOST=${shQuote(host)}
PORT=${shQuote(String(port))}
PIN=${shQuote(pin)}
TOKEN="\${NC_TOKEN:-}"
[ -n "$TOKEN" ] || { echo "NC_TOKEN is not set: use the command from NanoClaw's Add machine."; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
for c in curl openssl systemctl; do command -v "$c" >/dev/null || { echo "Needs $c."; exit 1; }; done
URL="https://$HOST:$PORT"
PINNED="-k --pinnedpubkey sha256//$PIN"
if ! curl -sS -o /dev/null --connect-timeout 5 $PINNED "$URL/healthz"; then
  echo "Can't reach NanoClaw at $HOST:$PORT. Add an inbound rule on its network security group:"
  echo "  source $(hostname -I | cut -d' ' -f1), destination $HOST, TCP $PORT"
  exit 1
fi
if ! command -v docker >/dev/null; then
  echo "Docker not found: installing it with get.docker.com."
  curl -fsSL https://get.docker.com | sh
fi
DIR=/etc/nanoclaw-machine
LIB=/usr/local/lib/nanoclaw-machine
mkdir -p "$DIR" "$LIB"
chmod 700 "$DIR"
[ -f "$DIR/key.pem" ] || openssl ecparam -name prime256v1 -genkey -noout -out "$DIR/key.pem"
chmod 600 "$DIR/key.pem"
openssl req -new -key "$DIR/key.pem" -subj /CN=nanoclaw-machine -out "$DIR/req.csr"
CSR=$(base64 -w0 "$DIR/req.csr")
CPUS=$(nproc)
MEM=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
DISK=$(df -BG --output=size / | tail -1 | tr -dc '0-9')
NAME=$(hostname | tr -dc 'A-Za-z0-9._-')
OS=$( (. /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-linux}") | tr -dc 'A-Za-z0-9 ._()/-')
BODY=$(printf '{"token":"%s","csr":"%s","facts":{"hostname":"%s","os":"%s","cpus":%s,"memTotalMb":%s,"diskTotalGb":%s}}' \\
  "$TOKEN" "$CSR" "$NAME" "$OS" "$CPUS" "$MEM" "$DISK")
REPLY=$(curl -fsS --max-time 30 $PINNED -H 'content-type: application/json' --data "$BODY" "$URL/enroll") || {
  echo "NanoClaw refused to add this machine (token used, expired or wrong)."; exit 1; }
ID=$(printf '%s\\n' "$REPLY" | sed -n 's/^id //p')
JOINED=$(printf '%s\\n' "$REPLY" | sed -n 's/^name //p')
printf '%s\\n' "$REPLY" | sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' > "$DIR/cert.pem"
printf 'HOST=%s\\nPORT=%s\\nPIN=%s\\nID=%s\\n' "$HOST" "$PORT" "$PIN" "$ID" > "$DIR/config"
rm -f "$DIR/revoked" "$DIR/state" "$DIR/req.csr"
cat > "$LIB/report.sh" <<'NC_REPORT'
${REPORT}NC_REPORT
chmod 755 "$LIB/report.sh"
cat > /etc/systemd/system/nanoclaw-machine.service <<'NC_UNIT'
${UNIT}NC_UNIT
cat > /etc/systemd/system/nanoclaw-machine.timer <<'NC_TIMER'
${TIMER}NC_TIMER
systemctl daemon-reload
systemctl enable --now nanoclaw-machine.timer >/dev/null
"$LIB/report.sh" || true
echo "Joined NanoClaw as $JOINED."
`;
}

export const reportScript = (): string => REPORT;
