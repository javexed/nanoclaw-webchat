/**
 * The Cloudflare Tunnel connector: one `cloudflared` container per install on
 * the edge network (tailnet/edge.ts) at a fixed address, running this
 * install's remotely-managed tunnel. Its ingress (one hostname per app, to
 * the gateway on the edge network's host address) lives in Cloudflare and is
 * changed through the API, so publishing an app never restarts it.
 *
 * The container: every capability dropped, no-new-privileges, read-only
 * root, NanoClaw's own uid, no autoupdate, metrics on its own loopback only,
 * remote diagnostics off. The tunnel token reaches it as a 0600 file
 * (`--token-file`), so `docker inspect` shows a path, never the token, and it
 * is in no environment variable.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { INSTALL_SLUG } from '../../../config.js';
import { CONNECTOR_LABEL } from '../tailnet/edge.js';
import { edgeNetworkName } from '../tailnet/config.js';
import type { DockerRun } from '../tailnet/sidecar.js';
import type { CloudflareConfig } from './config.js';
import { cloudflareDir } from './state.js';

export const TUNNEL_LABEL = 'nanoclaw-workload-cloudflare-tunnel';
export const SPEC_LABEL = 'nanoclaw-workload-cloudflare-spec';
export const connectorName = (): string => `nanoclaw-cloudflared-${INSTALL_SLUG}`;
export const tokenDir = (): string => path.join(cloudflareDir(), 'connector');
export const TOKEN_FILE = 'token';
/** Inside the container. */
const TOKEN_MOUNT = '/run/cf';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ConnectorSpec {
  cfg: CloudflareConfig;
  tunnelId: string;
  uid: number;
  gid: number;
}

/** The `docker run` arguments after `-d --name <name> --label <spec>`; their hash labels the container. */
export function connectorArgs(s: ConnectorSpec): string[] {
  if (!UUID_RE.test(s.tunnelId)) throw new Error('cloudflare: bad tunnel id');
  if (!s.cfg.connector.startsWith(`${s.cfg.prefix}.`))
    throw new Error('cloudflare: connector address outside the edge network');
  return [
    '--label',
    `${CONNECTOR_LABEL}=${INSTALL_SLUG}`,
    '--label',
    `${TUNNEL_LABEL}=${s.tunnelId}`,
    '--restart',
    'unless-stopped',
    '--network',
    edgeNetworkName(),
    '--ip',
    s.cfg.connector,
    '--user',
    `${s.uid}:${s.gid}`,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    '256m',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=3',
    '--tmpfs',
    `/tmp:uid=${s.uid},gid=${s.gid},mode=0700`,
    '-v',
    `${tokenDir()}:${TOKEN_MOUNT}:ro`,
    s.cfg.image,
    // The image's entrypoint is `cloudflared --no-autoupdate`.
    'tunnel',
    '--no-autoupdate',
    '--edge-ip-version',
    '4',
    '--metrics',
    '127.0.0.1:20241',
    '--management-diagnostics=false',
    '--loglevel',
    'info',
    'run',
    '--token-file',
    `${TOKEN_MOUNT}/${TOKEN_FILE}`,
  ];
}

export const specHash = (args: string[]): string =>
  createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);

/** Write the tunnel token for the connector: 0600 in a 0700 folder, replaced atomically. Never logged. */
export function writeTokenFile(token: string): void {
  if (!/^[A-Za-z0-9+/=_-]{40,4096}$/.test(token))
    throw new Error('cloudflare: the tunnel token has an unexpected shape');
  fs.mkdirSync(tokenDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(tokenDir(), 0o700);
  const tmp = path.join(tokenDir(), `.${TOKEN_FILE}.${process.pid}.tmp`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, token, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, path.join(tokenDir(), TOKEN_FILE));
}

export const hasTokenFile = (): boolean => fs.existsSync(path.join(tokenDir(), TOKEN_FILE));

export function removeTokenFile(): void {
  fs.rmSync(path.join(tokenDir(), TOKEN_FILE), { force: true });
}

/** Running, with the arguments it was created with? */
export async function connectorState(docker: DockerRun): Promise<{ running: boolean; spec: string } | null> {
  const out = await docker([
    'inspect',
    '-f',
    `{{.State.Running}} {{index .Config.Labels "${SPEC_LABEL}"}}`,
    connectorName(),
  ]).catch(() => null);
  if (out === null) return null;
  const [running, spec = ''] = out.trim().split(' ');
  return { running: running === 'true', spec };
}

export async function startConnector(docker: DockerRun, args: string[]): Promise<void> {
  await docker(['rm', '--force', connectorName()]).catch(() => undefined);
  await docker(['run', '-d', '--name', connectorName(), '--label', `${SPEC_LABEL}=${specHash(args)}`, ...args]);
}

export async function removeConnector(docker: DockerRun): Promise<void> {
  await docker(['rm', '--force', connectorName()]).catch(() => undefined);
}
