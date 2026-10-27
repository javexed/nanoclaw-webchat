/**
 * One Tailscale sidecar per published app: a `tailscale/tailscale` container
 * on this install's edge network (edge.ts) at a fixed address, joined to the
 * tailnet as a tagged device named after the app, serving
 * https://<app>.<tailnet>.ts.net with `tailscale serve` to the gateway.
 *
 * Why its own network namespace and not the host's: in userspace mode,
 * tailscaled forwards a tailnet connection to any port it does not serve to
 * 127.0.0.1 on that port. On the host network that would be the host's
 * loopback (webchat, the gateway, anything else); here it is the sidecar's own
 * empty loopback.
 *
 * The container: userspace networking (no TUN, no NET_ADMIN), every
 * capability dropped, no-new-privileges, read-only root, NanoClaw's own uid,
 * its own state folder and LocalAPI socket, no metrics or health listener. The
 * auth key reaches it as a 0600 file (TS_AUTHKEY=file:…, so `docker inspect`
 * shows a path, never the key), used once (TS_AUTH_ONCE) and deleted as soon
 * as the device is up. The serve config never turns on Funnel.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { INSTALL_SLUG } from '../../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../../container-runtime.js';
import { dockerEnv } from '../docker.js';
import type { TailnetConfig } from './config.js';
import { edgeNetworkName } from './config.js';
import { tailnetDir } from './state.js';

const pexec = promisify(execFile);

/** Run the container runtime; stdout. Injectable: tests use a fake docker. */
export type DockerRun = (args: string[], timeoutMs?: number) => Promise<string>;

export const realDocker: DockerRun = async (args, timeoutMs = 120_000) => {
  if (process.env.VITEST) throw new Error('tailnet: no real docker under the test runner');
  return (await pexec(CONTAINER_RUNTIME_BIN, args, { env: dockerEnv(), timeout: timeoutMs, maxBuffer: 4 << 20 }))
    .stdout;
};

/** Labels: never the install label (the startup sweep removes containers carrying it as leftover agents). */
export const SIDECAR_LABEL = 'nanoclaw-workload-tailnet';
export const ROUTE_LABEL = 'nanoclaw-workload-tailnet-route';
export const SPEC_LABEL = 'nanoclaw-workload-tailnet-spec';

export const sidecarName = (app: string): string => `nanoclaw-tailnet-${INSTALL_SLUG}-${app}`;
export const sidecarDir = (routeId: string): string => path.join(tailnetDir(), routeId);

/** Inside the container. */
const STATE = '/var/lib/tailscale';
const KEY_DIR = '/run/ts-key';
const SERVE_DIR = '/run/ts-serve';
export const SOCKET = '/tmp/tailscaled.sock';
export const KEY_FILE = 'authkey';

/**
 * The serve config: HTTPS on 443 for the device's own name, proxied to the
 * gateway. Plain data; `${TS_CERT_DOMAIN}` is filled in by containerboot.
 */
export function serveConfig(gateway: string, gatewayPort: number): Record<string, unknown> {
  if (
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(gateway) ||
    !Number.isInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65535
  )
    throw new Error('tailnet: bad gateway address for the serve config');
  const cfg = {
    TCP: { '443': { HTTPS: true } },
    Web: { '${TS_CERT_DOMAIN}:443': { Handlers: { '/': { Proxy: `http://${gateway}:${gatewayPort}` } } } },
  };
  assertNoFunnel(cfg);
  return cfg;
}

/** Funnel would publish the app to the internet: refused anywhere in a serve config. */
export function assertNoFunnel(cfg: unknown): void {
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (/funnel/i.test(k) && x !== false && !(x && typeof x === 'object' && Object.keys(x).length === 0))
        throw new Error('tailnet: a serve config must never turn on Funnel');
      walk(x);
    }
  };
  walk(cfg);
}

export interface SidecarSpec {
  routeId: string;
  app: string;
  address: string;
  cfg: TailnetConfig;
  gatewayPort: number;
  dir: string;
  uid: number;
  gid: number;
}

/** The `docker run` arguments after `-d --name <name> --label <spec>`; their hash labels the container. */
export function runArgs(s: SidecarSpec): string[] {
  if (!/^[a-z0-9-]{1,40}$/.test(s.app)) throw new Error('tailnet: bad app name');
  if (!s.address.startsWith(`${s.cfg.prefix}.`)) throw new Error('tailnet: sidecar address outside the edge network');
  return [
    '--label',
    `${SIDECAR_LABEL}=${INSTALL_SLUG}`,
    '--label',
    `${ROUTE_LABEL}=${s.routeId}`,
    '--restart',
    'unless-stopped',
    '--network',
    edgeNetworkName(),
    '--ip',
    s.address,
    '--hostname',
    s.app,
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
    `${path.join(s.dir, 'state')}:${STATE}`,
    '-v',
    `${path.join(s.dir, 'key')}:${KEY_DIR}:ro`,
    '-v',
    `${path.join(s.dir, 'serve')}:${SERVE_DIR}:ro`,
    '-e',
    'TS_USERSPACE=true',
    '-e',
    `TS_STATE_DIR=${STATE}`,
    '-e',
    `TS_SOCKET=${SOCKET}`,
    '-e',
    'TS_AUTH_ONCE=true',
    '-e',
    `TS_AUTHKEY=file:${KEY_DIR}/${KEY_FILE}`,
    '-e',
    `TS_HOSTNAME=${s.app}`,
    '-e',
    `TS_EXTRA_ARGS=--advertise-tags=${s.cfg.tag}`,
    '-e',
    `TS_SERVE_CONFIG=${SERVE_DIR}/serve.json`,
    '-e',
    'TS_ACCEPT_DNS=false',
    // Nothing listens but tailscaled itself: no metrics, no health check, and
    // were either ever on, only on the container's own loopback.
    '-e',
    'TS_ENABLE_METRICS=false',
    '-e',
    'TS_ENABLE_HEALTH_CHECK=false',
    '-e',
    'TS_LOCAL_ADDR_PORT=127.0.0.1:9002',
    s.cfg.image,
  ];
}

export const specHash = (args: string[]): string =>
  createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);

/** The sidecar's folders (0700) and its serve config (0600). */
export function prepareDir(s: SidecarSpec): void {
  for (const sub of ['', 'state', 'key', 'serve']) {
    fs.mkdirSync(path.join(s.dir, sub), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(s.dir, sub), 0o700);
  }
  fs.writeFileSync(
    path.join(s.dir, 'serve', 'serve.json'),
    JSON.stringify(serveConfig(s.cfg.gateway, s.gatewayPort), null, 2),
    { mode: 0o600 },
  );
}

/** The auth key, for the container's first login only. */
export function writeKeyFile(dir: string, key: string): void {
  if (!/^tskey-auth-[A-Za-z0-9_-]+$/.test(key))
    throw new Error('tailnet: Tailscale gave an auth key of an unexpected shape');
  const f = path.join(dir, 'key', KEY_FILE);
  fs.rmSync(f, { force: true });
  fs.writeFileSync(f, key, { mode: 0o600, flag: 'wx' });
}

export function removeKeyFile(dir: string): void {
  fs.rmSync(path.join(dir, 'key', KEY_FILE), { force: true });
}

/** Has this sidecar logged in before (it keeps its device across restarts)? */
export const hasState = (dir: string): boolean => {
  try {
    return fs.readdirSync(path.join(dir, 'state')).length > 0;
  } catch {
    return false;
  }
};

export interface DeviceStatus {
  backendState: string;
  /** host.tailnet.ts.net, without the trailing dot. */
  dnsName: string;
  nodeId: string;
  tags: string[];
}

/** What the sidecar's tailscaled says about itself; null while it does not answer. */
export async function deviceStatus(docker: DockerRun, name: string): Promise<DeviceStatus | null> {
  const out = await docker(
    ['exec', name, 'tailscale', `--socket=${SOCKET}`, 'status', '--json', '--peers=false'],
    20_000,
  ).catch(() => null);
  if (!out) return null;
  try {
    const j = JSON.parse(out) as {
      BackendState?: unknown;
      Self?: { DNSName?: unknown; ID?: unknown; Tags?: unknown };
    };
    return {
      backendState: typeof j.BackendState === 'string' ? j.BackendState : '',
      dnsName: typeof j.Self?.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '').toLowerCase() : '',
      nodeId: typeof j.Self?.ID === 'string' ? j.Self.ID : '',
      tags: Array.isArray(j.Self?.Tags) ? j.Self.Tags.filter((t): t is string => typeof t === 'string') : [],
    };
  } catch {
    return null;
  }
}

/** Is serve on for this hostname, and Funnel off? */
export async function serving(docker: DockerRun, name: string, hostname: string): Promise<boolean> {
  const out = await docker(
    ['exec', name, 'tailscale', `--socket=${SOCKET}`, 'serve', 'status', '--json'],
    20_000,
  ).catch(() => null);
  if (!out) return false;
  try {
    const j = JSON.parse(out) as { Web?: Record<string, unknown> };
    assertNoFunnel(j);
    return Boolean(j.Web && `${hostname}:443` in j.Web);
  } catch {
    return false;
  }
}

/** The sidecars of this install that exist, running or not: name → route id. */
export async function listSidecars(docker: DockerRun): Promise<Map<string, string>> {
  const out = await docker([
    'ps',
    '-a',
    '--filter',
    `label=${SIDECAR_LABEL}=${INSTALL_SLUG}`,
    '--format',
    `{{.Names}} {{.Label "${ROUTE_LABEL}"}}`,
  ]);
  const m = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, route] = line.trim().split(' ');
    if (name) m.set(name, route ?? '');
  }
  return m;
}

/** Running, with the arguments it was created with? */
export async function containerState(
  docker: DockerRun,
  name: string,
): Promise<{ running: boolean; spec: string } | null> {
  const out = await docker([
    'inspect',
    '-f',
    `{{.State.Running}} {{index .Config.Labels "${SPEC_LABEL}"}}`,
    name,
  ]).catch(() => null);
  if (out === null) return null;
  const [running, spec = ''] = out.trim().split(' ');
  return { running: running === 'true', spec };
}

/**
 * How often Docker restarted it. A sidecar whose saved login is gone runs
 * `tailscale up` with the (deleted) key file, fails and is restarted: a
 * keyless start that keeps restarting needs a new key.
 */
export async function restartCount(docker: DockerRun, name: string): Promise<number> {
  const out = await docker(['inspect', '-f', '{{.RestartCount}}', name]).catch(() => '0');
  return Number(out.trim()) || 0;
}

export async function startContainer(docker: DockerRun, name: string, args: string[]): Promise<void> {
  await docker(['rm', '--force', name]).catch(() => undefined);
  await docker(['run', '-d', '--name', name, '--label', `${SPEC_LABEL}=${specHash(args)}`, ...args]);
}

export async function removeContainer(docker: DockerRun, name: string): Promise<void> {
  await docker(['rm', '--force', name]).catch(() => undefined);
}
