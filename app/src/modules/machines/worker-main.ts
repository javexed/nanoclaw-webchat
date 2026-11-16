/**
 * The worker service (docs/webchat/scaling.md): runs on a machine with the worker
 * role, as root under systemd, on the machine's own Node (18 or later). It
 * keeps ONE mutual-TLS link to central (mux.ts) with the machine's key and
 * certificate from joining, and does only what central asks from a fixed set:
 *
 *   docker   a `docker` command from an allowlist (Compose for NanoClaw's
 *            projects, networks and images it names), with the Compose files
 *            central sends, in this worker's own folder
 *   slice    size the workloads systemd slice to NanoClaw's share of this machine
 *   rmdir    remove a workload's folder
 *   probe    run the workload isolation check now, with the helper image central sent
 *   tcp      a byte stream to a service address of a workload on this machine
 *   vol-out / vol-in   a workload volume as a tar stream (backups, restores)
 *   image    an image central sends (docker save on central, loaded here as
 *            is); hasImage says which one a tag holds now. A stack's images
 *            are pulled or built on central (behind its egress filter) and
 *            sent here: this machine never pulls from a registry or builds
 *
 * There is no general shell. Health goes to central every minute over the link.
 * Built-ins only (and ./mux.js): it is served by central and run as is.
 *
 * Isolation. Workload networks are internal, but Docker does not filter
 * traffic addressed to this machine itself: from a workload container every
 * service listening here answers at its network's gateway address. The host
 * rules (workloads-host-rules.sh, installed with this service) drop that.
 * This service checks they work by trying, as central does for itself: a
 * throwaway container on a probe network shaped like a workload network asks
 * a listener on the gateway address. At start and every half hour; the
 * result goes to central with each health report. Until it passes, compose
 * up/start/restart are refused here; when it gets through, every running
 * workload here is stopped. Central places nothing on a worker whose recent
 * check did not pass.
 */
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import type { Duplex } from 'stream';
import tls from 'tls';

import { Mux, type Message } from './mux.js';

export const WORKER_VERSION = '7';
const CONF_DIR = process.env.NC_MACHINE_DIR || '/etc/nanoclaw-machine';
const WORK = process.env.NC_WORKER_DIR || '/var/lib/nanoclaw-worker';
const MAX_OUT = 20_000;
/** Reconnect this often, so a renewed certificate is used. */
const RECYCLE_MS = 12 * 3600_000;

// ── what central may ask ──────────────────────────────────────────────────────

const COMPOSE_SUB = new Set([
  'up',
  'down',
  'ps',
  'logs',
  'exec',
  'stop',
  'start',
  'restart',
  'config',
  'images',
  'top',
]);
const COMPOSE_FILES = new Set(['stack.yml', 'override.yml']);
const NAME = /^nc-[a-z0-9_.-]{1,120}$/;
const DIR = /^[A-Za-z0-9-]{1,80}$/;
const SLICE = /^nanoclaw[A-Za-z0-9_.-]{0,100}\.slice$/;
const IMAGE = /^[a-z0-9][a-z0-9./:@_-]{0,200}$/;

/** Why these docker arguments are refused, or null when they are allowed. */
export function refuseDocker(args: unknown): string | null {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return 'arguments must be strings';
  const a = args as string[];
  const [cmd, sub] = a;
  if (cmd === 'version' || cmd === 'info') return null;
  if (cmd === 'compose') {
    let i = 1;
    let project = '';
    while (i < a.length && a[i].startsWith('-')) {
      const flag = a[i];
      if (flag === '-p') project = a[i + 1] ?? '';
      else if (flag === '-f') {
        if (!COMPOSE_FILES.has(a[i + 1] ?? '')) return 'only stack.yml and override.yml';
      } else return `compose flag ${flag} not allowed`;
      i += 2;
    }
    if (!NAME.test(project)) return 'a NanoClaw project (-p nc-…) is required';
    if (!COMPOSE_SUB.has(a[i] ?? '')) return `compose ${a[i] ?? ''} not allowed`;
    // Images come from central (image-load), never straight from a registry.
    if (a[i] === 'up') {
      const p = a.indexOf('--pull', i);
      if (p < 0 || a[p + 1] !== 'never') return 'compose up needs --pull never';
    }
    return null;
  }
  if (cmd === 'network') {
    if (sub === 'ls') return null;
    if (sub === 'inspect') return null;
    if (sub === 'rm' && a.length === 3 && NAME.test(a[2])) return null;
    if (sub === 'create') return refuseNetworkCreate(a);
    return `network ${sub ?? ''} not allowed`;
  }
  if (cmd === 'image') {
    if (sub === 'inspect' || sub === 'ls') return null;
    if (sub === 'prune' && a.includes('-f')) return null;
    return `image ${sub ?? ''} not allowed`;
  }
  if (cmd === 'system' && sub === 'df') return null;
  return `docker ${cmd ?? ''} not allowed`;
}

/**
 * `network create` only in the one shape a workload network has (docker.ts
 * createInternalNetwork): internal, a /24 of 198.18.0.0/15 with its .1 as
 * gateway and its upper half for containers, a bridge named ncw…, NanoClaw's
 * label. Anything else (a macvlan on the LAN, a network that is not internal)
 * is refused.
 */
export function refuseNetworkCreate(a: string[]): string | null {
  const bad = 'network create: only an internal workload network';
  if (a.length !== 14) return bad;
  const [, , internal, fSubnet, subnet, fGw, gateway, fRange, range, fOpt, opt, fLabel, label, name] = a;
  if (internal !== '--internal' || fSubnet !== '--subnet' || fGw !== '--gateway' || fRange !== '--ip-range') return bad;
  if (fOpt !== '-o' || fLabel !== '--label' || !NAME.test(name)) return bad;
  const m = /^(198\.1[89]\.(\d{1,3}))\.0\/24$/.exec(subnet);
  if (!m || Number(m[2]) > 255) return bad;
  if (gateway !== `${m[1]}.1` || range !== `${m[1]}.128/25`) return bad;
  if (!/^com\.docker\.network\.bridge\.name=ncw[a-z0-9]{1,12}$/.test(opt)) return bad;
  if (!/^nanoclaw-workloads=[A-Za-z0-9_.-]{1,80}$/.test(label)) return bad;
  return null;
}

// ── the Compose files central sends ───────────────────────────────────────────
//
// Central checks every stack (workloads/policy.ts) and writes NanoClaw's
// override (workloads/override.ts) before anything is sent here. This machine
// checks the files again rather than trust that: a central that is not itself
// any more must not be able to run a privileged container, mount this
// machine's files, or join its host namespaces. Central sends the files as
// JSON (which Compose reads as YAML), so they parse with built-ins.

/** Service keys a stack may use here: central's allowlist (policy.ts), without build. */
const SERVICE_KEYS = new Set([
  'image',
  'command',
  'entrypoint',
  'environment',
  'working_dir',
  'user',
  'healthcheck',
  'depends_on',
  'expose',
  'labels',
  'volumes',
  'tmpfs',
  'mem_limit',
  'cpus',
  'deploy',
  'stop_grace_period',
  'stop_signal',
  'init',
  'read_only',
  'shm_size',
  'hostname',
  'platform',
  'restart',
  'cap_add',
  'configs',
]);
/** Capabilities a service may add back (policy.ts CAP_ADD_ALLOWED). */
const CAPS = new Set(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETUID', 'SETGID', 'NET_BIND_SERVICE', 'KILL']);
/** Label prefixes only NanoClaw and Compose set. */
const RESERVED_LABEL = /^(nanoclaw[.-]|com\.docker\.)/;
/** The images a stack runs here: the ones central sent (docker.ts pulledImageName / builtImageName). */
const STACK_IMAGE = /^nc-[a-z0-9_.-]{1,160}:(pulled|built)$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function labelKeys(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? v.map((x) => String(x).split('=')[0]) : null;
  if (isObj(v)) return Object.keys(v);
  return v === undefined ? [] : null;
}

/** A volume mount is a named volume of the stack or a tmpfs, never a path on this machine. */
function volumeMountOk(v: unknown, named: Set<string>): boolean {
  if (typeof v === 'string') {
    const [src = '', dst = '', ...rest] = v.split(':');
    if (!dst || rest.length > 1 || (rest.length === 1 && !['ro', 'rw'].includes(rest[0]))) return false;
    return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(src) && named.has(src);
  }
  if (!isObj(v)) return false;
  if (v.type === 'tmpfs') return v.source === undefined;
  return v.type === 'volume' && typeof v.source === 'string' && named.has(v.source) && v.bind === undefined;
}

function hasKeyDeep(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, key));
  if (!isObj(v)) return false;
  return Object.entries(v).some(([k, x]) => k === key || hasKeyDeep(x, key));
}

function refuseStack(stack: unknown, project: string): string | null {
  if (!isObj(stack)) return 'stack.yml must be an object';
  for (const k of Object.keys(stack))
    if (k !== 'services' && k !== 'volumes' && k !== 'configs') return `stack.yml: ${k} not allowed`;
  // Configs: inline content only (central's translate.ts), never a file or variable of this machine.
  const configs = stack.configs ?? {};
  if (!isObj(configs)) return 'stack.yml: configs must be an object';
  for (const [name, c] of Object.entries(configs))
    if (!isObj(c) || Object.keys(c).join() !== 'content' || typeof c.content !== 'string')
      return `config ${name}: inline content only`;
  const volumes = stack.volumes ?? {};
  if (!isObj(volumes)) return 'stack.yml: volumes must be an object';
  for (const [name, v] of Object.entries(volumes)) {
    if (v === null) continue;
    if (!isObj(v)) return `volume ${name}: bad definition`;
    for (const k of Object.keys(v)) if (k !== 'driver') return `volume ${name}: ${k} not allowed`;
    if (v.driver !== undefined && v.driver !== 'local') return `volume ${name}: only the local driver`;
  }
  const named = new Set(Object.keys(volumes));
  if (!isObj(stack.services) || !Object.keys(stack.services).length) return 'stack.yml: no services';
  for (const [name, svc] of Object.entries(stack.services)) {
    if (!isObj(svc)) return `${name}: bad service`;
    for (const k of Object.keys(svc))
      if (!SERVICE_KEYS.has(k) && !k.startsWith('x-')) return `${name}: ${k} not allowed`;
    if (typeof svc.image !== 'string' || !STACK_IMAGE.test(svc.image) || !svc.image.startsWith(`${project}-`))
      return `${name}: only an image NanoClaw sent for this stack`;
    if (svc.cap_add !== undefined) {
      if (!Array.isArray(svc.cap_add)) return `${name}: cap_add must be a list`;
      for (const c of svc.cap_add)
        if (typeof c !== 'string' || !CAPS.has(c.toUpperCase().replace(/^CAP_/, '')))
          return `${name}: capability ${String(c)} not allowed`;
    }
    if (svc.configs !== undefined) {
      if (!Array.isArray(svc.configs)) return `${name}: configs must be a list`;
      for (const c of svc.configs)
        if (
          !isObj(c) ||
          typeof c.source !== 'string' ||
          !Object.hasOwn(configs, c.source) ||
          (c.target !== undefined && (typeof c.target !== 'string' || !c.target.startsWith('/'))) ||
          Object.keys(c).some((k) => !['source', 'target', 'mode', 'uid', 'gid'].includes(k))
        )
          return `${name}: configs name a config of the stack`;
    }
    if (svc.volumes !== undefined) {
      if (!Array.isArray(svc.volumes)) return `${name}: volumes must be a list`;
      for (const v of svc.volumes) if (!volumeMountOk(v, named)) return `${name}: only named volumes of the stack`;
    }
    const labels = labelKeys(svc.labels);
    if (!labels) return `${name}: bad labels`;
    if (labels.some((l) => RESERVED_LABEL.test(l))) return `${name}: reserved label`;
    if (svc.deploy !== undefined && (!isObj(svc.deploy) || hasKeyDeep(svc.deploy, 'devices')))
      return `${name}: devices not allowed`;
  }
  return null;
}

function refuseOverride(o: unknown, stack: Record<string, unknown>, project: string): string | null {
  const bad = (why: string) => `override.yml: ${why}`;
  if (!isObj(o)) return bad('must be an object');
  if (!sameJson(Object.keys(o).sort(), ['name', 'networks', 'services'])) return bad('unexpected keys');
  if (o.name !== project) return bad('another project');
  const net = isObj(o.networks) ? o.networks.nanoclaw : undefined;
  if (!isObj(o.networks) || Object.keys(o.networks).length !== 1 || !isObj(net)) return bad('one network');
  if (!sameJson(Object.keys(net).sort(), ['external', 'name']) || net.external !== true || !NAME.test(String(net.name)))
    return bad('the stack network must be an existing workload network');
  const services = isObj(o.services) ? o.services : null;
  const names = Object.keys(isObj(stack.services) ? stack.services : {}).sort();
  if (!services || !sameJson(Object.keys(services).sort(), names)) return bad('services differ from the stack');
  const keys = ['cap_drop', 'cgroup_parent', 'deploy', 'labels', 'logging', 'networks', 'security_opt'];
  for (const [name, s] of Object.entries(services)) {
    if (!isObj(s) || !sameJson(Object.keys(s).sort(), keys)) return bad(`${name}: unexpected keys`);
    if (!sameJson(s.cap_drop, ['ALL'])) return bad(`${name}: every capability must be dropped`);
    if (!sameJson(s.security_opt, ['no-new-privileges:true'])) return bad(`${name}: no-new-privileges`);
    if (typeof s.cgroup_parent !== 'string' || !SLICE.test(s.cgroup_parent)) return bad(`${name}: the workloads slice`);
    const addr = isObj(s.networks) && isObj(s.networks.nanoclaw) ? s.networks.nanoclaw.ipv4_address : undefined;
    if (!isObj(s.networks) || Object.keys(s.networks).length !== 1 || !isObj(s.networks.nanoclaw))
      return bad(`${name}: the stack network only`);
    const netKeys = Object.keys(s.networks.nanoclaw).sort().join();
    if ((netKeys !== 'ipv4_address' && netKeys !== 'aliases,ipv4_address') || !serviceAddress(addr))
      return bad(`${name}: a service address`);
    const aliases = s.networks.nanoclaw.aliases;
    if (
      aliases !== undefined &&
      (!Array.isArray(aliases) ||
        !aliases.every((a) => typeof a === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(a)))
    )
      return bad(`${name}: aliases are host names`);
    if (!sameJson(s.logging, { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } }))
      return bad(`${name}: logging`);
    const labels = labelKeys(s.labels);
    if (!labels || !isObj(s.labels) || labels.some((l) => !l.startsWith('nanoclaw.')))
      return bad(`${name}: NanoClaw's labels only`);
    const pids =
      isObj(s.deploy) && isObj(s.deploy.resources) && isObj(s.deploy.resources.limits)
        ? s.deploy.resources.limits.pids
        : undefined;
    if (
      !sameJson(Object.keys(s.deploy as object), ['resources']) ||
      !Number.isInteger(pids) ||
      Number(pids) < 1 ||
      Number(pids) > 65536
    )
      return bad(`${name}: a pids limit`);
  }
  return null;
}

/**
 * Why the Compose files central sent for `project` are refused here, or null.
 * Both must be there: a stack (central's checked services, images it sent)
 * and NanoClaw's override (every capability dropped, no new privileges, the
 * workloads slice, a service address on the stack's internal network).
 */
export function refuseComposeFiles(files: Record<string, unknown>, project: string): string | null {
  if (!NAME.test(project)) return 'a NanoClaw project is required';
  const parsed: Record<string, unknown> = {};
  for (const f of COMPOSE_FILES) {
    const text = files[f];
    if (typeof text !== 'string') return `${f} is missing`;
    try {
      parsed[f] = JSON.parse(text);
    } catch {
      return `${f} must be JSON`;
    }
  }
  const stack = parsed['stack.yml'];
  return (
    refuseStack(stack, project) ?? refuseOverride(parsed['override.yml'], stack as Record<string, unknown>, project)
  );
}

/** A service address: .10–.127 of a workload network (never the gateway .1, which is this machine). */
function serviceAddress(host: unknown): boolean {
  if (!workloadAddress(host)) return false;
  const last = Number(String(host).split('.')[3]);
  return last >= FIRST_SERVICE && last <= LAST_SERVICE;
}

/** Is this an address of a workload network (198.18.0.0/15)? */
export function workloadAddress(host: unknown): boolean {
  if (typeof host !== 'string' || net.isIPv4(host) === false) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

/** Services hold .10–.127 of their network (override.ts); .1 is this machine itself. */
const FIRST_SERVICE = 10;
const LAST_SERVICE = 127;

/**
 * May a tcp stream go to host:port? Only to the address of a workload
 * service that runs here now (`held`, from Docker): never the gateway .1
 * (this machine), nor any other address in the range.
 */
export function tcpAllowed(host: unknown, port: unknown, held: ReadonlySet<string>): boolean {
  const p = Number(port);
  if (!workloadAddress(host) || !Number.isInteger(p) || p < 1 || p > 65535) return false;
  const last = Number(String(host).split('.')[3]);
  return last >= FIRST_SERVICE && last <= LAST_SERVICE && held.has(String(host));
}

/** The -p project of a compose command ('' when there is none). */
function composeProject(args: string[]): string {
  if (args[0] !== 'compose') return '';
  const i = args.indexOf('-p');
  return i > 0 ? (args[i + 1] ?? '') : '';
}

/** Write a file whole or not at all, with its mode set before any content is in it. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

/** Compose verbs that start containers: refused here until the isolation check passes. */
const STARTS = new Set(['up', 'start', 'restart']);

/** Why these (already allowed) docker arguments must wait for the isolation check, or null. */
export function refuseWhileUnisolated(args: string[], state: IsolationState): string | null {
  if (state === 'ok' || args[0] !== 'compose') return null;
  let i = 1;
  while (i < args.length && args[i].startsWith('-')) i += 2;
  if (!STARTS.has(args[i] ?? '')) return null;
  return state === 'open'
    ? 'workloads are stopped on this machine: a workload could reach the machine itself (install the host rules: workloads-host-rules.sh --install-unit)'
    : 'the workload isolation check has not passed on this machine yet';
}

// ── isolation ─────────────────────────────────────────────────────────────────

export type IsolationState = 'ok' | 'open' | 'unknown';
export const PROBE_EVERY_MS = 30 * 60_000;
/** The probe network: internal, its bridge named ncw… like every workload bridge (the host rules match ncw+). */
const PROBE_NET = 'nc-worker-probe';
const PROBE_BRIDGE = 'ncwprobe';
/** 198.19.255.0/24: the range's last /24, which no workload network takes. */
const PROBE_PREFIX = /^198\.1[89]\.\d{1,3}$/.test(process.env.NC_PROBE_PREFIX ?? '')
  ? String(process.env.NC_PROBE_PREFIX)
  : '198.19.255';
const PROBE_IMAGE_FILE = () => path.join(WORK, 'probe-image');

let isolation: { state: IsolationState; at: number; detail: string } = { state: 'unknown', at: Date.now(), detail: '' };
let probing: Promise<IsolationState> | null = null;

export const isolationNow = () => isolation;

/** What the probe container printed: the token came back (open), the request failed (blocked), or neither. */
export function readProbe(stdout: string, token: string): 'open' | 'blocked' | null {
  if (stdout.includes(token)) return 'open';
  if (/ rc=\d+/.test(stdout)) return 'blocked';
  return null;
}

/** The probe container: no capabilities, small, no logs, only a wget to the listener. */
export function probeArgs(network: string, image: string, url: string): string[] {
  return [
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    network,
    '--log-driver',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--memory',
    '64m',
    '--pids-limit',
    '16',
    image,
    'sh',
    '-c',
    `wget -q -T 4 -O- ${url} 2>/dev/null; echo " rc=$?"`,
  ];
}

async function ensureProbeNetwork(): Promise<void> {
  const gw = `${PROBE_PREFIX}.1`;
  const r = await run('docker', [
    'network',
    'inspect',
    PROBE_NET,
    '--format',
    '{{index .Options "com.docker.network.bridge.name"}} {{range .IPAM.Config}}{{.Gateway}}{{end}} {{.Internal}}',
  ]);
  if (r.code === 0 && r.stdout.trim() === `${PROBE_BRIDGE} ${gw} true`) return;
  if (r.code === 0) await run('docker', ['network', 'rm', PROBE_NET]);
  const c = await run('docker', [
    'network',
    'create',
    '--internal',
    '--subnet',
    `${PROBE_PREFIX}.0/24`,
    '--gateway',
    gw,
    '-o',
    `com.docker.network.bridge.name=${PROBE_BRIDGE}`,
    PROBE_NET,
  ]);
  if (c.code !== 0) throw new Error(`probe network: ${c.stderr.slice(0, 300)}`);
}

/** One check: can a container on a workload-shaped network reach this machine? */
async function probeOnce(image: string): Promise<'open' | 'blocked'> {
  if (!IMAGE.test(image)) throw new Error('no usable probe image');
  await ensureProbeNetwork();
  const gw = `${PROBE_PREFIX}.1`;
  const token = crypto.randomBytes(12).toString('hex');
  const server = http.createServer((_req, res) => res.end(token));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, gw, () => resolve());
  });
  try {
    const port = (server.address() as net.AddressInfo).port;
    const r = await run('docker', probeArgs(PROBE_NET, image, `http://${gw}:${port}/`), { timeoutMs: 60_000 });
    const seen = readProbe(r.stdout, token);
    if (!seen) throw new Error(`the probe gave no answer: ${(r.stderr || r.stdout).slice(0, 200)}`);
    return seen;
  } finally {
    server.close();
  }
}

/** Stop every running container of a NanoClaw Compose project here. */
async function stopAllWorkloads(): Promise<number> {
  const r = await run('docker', [
    'ps',
    '--filter',
    'label=com.docker.compose.project',
    '--format',
    '{{.ID}} {{.Label "com.docker.compose.project"}}',
  ]);
  const ids = r.stdout
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter(([id, project]) => id && NAME.test(project ?? ''))
    .map(([id]) => id);
  if (ids.length) await run('docker', ['stop', ...ids], { timeoutMs: 300_000 });
  return ids.length;
}

/**
 * Run the isolation check (one at a time) with `image`, or the image central
 * last sent. The result is kept and reported; when it gets through, every
 * workload here is stopped at once.
 */
export function runProbe(image?: string): Promise<IsolationState> {
  const given = !!image && IMAGE.test(image);
  if (given) fs.writeFileSync(PROBE_IMAGE_FILE(), image, { mode: 0o600 });
  // A check already under way may predate the image just given: run once more after it.
  if (probing) return given ? probing.then(() => runProbe()) : probing;
  probing = (async (): Promise<IsolationState> => {
    const img = fs.existsSync(PROBE_IMAGE_FILE()) ? fs.readFileSync(PROBE_IMAGE_FILE(), 'utf8').trim() : '';
    try {
      if (!img) throw new Error('central has not sent the probe image yet');
      const seen = await probeOnce(img);
      isolation = { state: seen === 'open' ? 'open' : 'ok', at: Date.now(), detail: '' };
    } catch (err) {
      isolation = { state: 'unknown', at: Date.now(), detail: String((err as Error).message ?? err).slice(0, 300) };
    }
    if (isolation.state === 'open') {
      const n = await stopAllWorkloads().catch(() => 0);
      console.error(`Workload isolation check got through: host rules missing. Stopped ${n} container(s).`);
    }
    return isolation.state;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

/** For tests: set the isolation state the docker job checks against. */
export function __setIsolationForTest(state: IsolationState, at = Date.now()): void {
  isolation = { state, at, detail: '' };
}

// ── the addresses workload services hold here ─────────────────────────────────

let heldCache: { at: number; set: Set<string> } | null = null;

/** Service addresses of NanoClaw's Compose projects running here (cached a few seconds). */
async function heldAddresses(): Promise<Set<string>> {
  if (heldCache && Date.now() - heldCache.at < 5_000) return heldCache.set;
  const set = new Set<string>();
  const nets = await run('docker', ['network', 'ls', '--filter', 'label=nanoclaw-workloads', '--format', '{{.Name}}']);
  const names = nets.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => NAME.test(n));
  if (names.length) {
    const r = await run('docker', [
      'network',
      'inspect',
      '--format',
      '{{range .Containers}}{{.Name}} {{.IPv4Address}}\n{{end}}',
      ...names,
    ]);
    for (const line of r.stdout.split('\n')) {
      const [name = '', cidr = ''] = line.trim().split(' ');
      if (NAME.test(name)) set.add(cidr.split('/')[0]);
    }
  }
  heldCache = { at: Date.now(), set };
  return set;
}

function run(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 600_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/root' },
      },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? Number((err as { code: number }).code)
            : 1
          : 0;
        const clip = (s: string) => (s.length > MAX_OUT ? `…${s.slice(-MAX_OUT)}` : s);
        resolve({
          code,
          stdout: clip(String(stdout)),
          stderr: clip(String(stderr || (err && !stdout ? err.message : ''))),
        });
      },
    );
  });
}

async function dockerOp(msg: Message) {
  const why = refuseDocker(msg.args) ?? refuseWhileUnisolated(msg.args as string[], isolation.state);
  if (why) throw new Error(`refused: ${why}`);
  let cwd: string | undefined;
  if (msg.dir !== undefined) {
    if (typeof msg.dir !== 'string' || !DIR.test(msg.dir)) throw new Error('refused: bad folder');
    cwd = path.join(WORK, 'wl', msg.dir);
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const files = (msg.files ?? {}) as Record<string, unknown>;
    for (const [name, text] of Object.entries(files))
      if (!COMPOSE_FILES.has(name) || typeof text !== 'string') throw new Error('refused: bad file');
    if (Object.keys(files).length) {
      const refused = refuseComposeFiles(files, composeProject(msg.args as string[]));
      if (refused) throw new Error(`refused: ${refused}`);
      for (const [name, text] of Object.entries(files)) writeAtomic(path.join(cwd, name), String(text));
    }
  }
  return run('docker', msg.args as string[], { cwd, timeoutMs: Number(msg.timeoutMs) || 600_000 });
}

async function sliceOp(msg: Message) {
  const name = String(msg.name ?? '');
  if (!SLICE.test(name)) throw new Error('refused: bad slice name');
  const mem = Math.max(64, Math.floor(Number(msg.memoryMb) || 0));
  const cpus = Math.max(0.1, Number(msg.cpus) || 0.1);
  const unit = path.join('/etc/systemd/system', name);
  if (!fs.existsSync(unit)) {
    fs.writeFileSync(
      unit,
      `[Unit]\nDescription=NanoClaw workloads (worker)\nBefore=slices.target\n\n[Slice]\nMemoryAccounting=yes\nCPUAccounting=yes\nTasksMax=4096\n`,
    );
    await run('systemctl', ['daemon-reload']);
  }
  await run('systemctl', ['start', name]);
  const props = [`MemoryMax=${mem}M`, `MemoryHigh=${Math.floor(mem * 0.9)}M`, `CPUQuota=${Math.round(cpus * 100)}%`];
  const r = await run('systemctl', ['set-property', name, ...props]);
  if (r.code !== 0) throw new Error(`slice: ${r.stderr.slice(0, 300)}`);
  return { name, memoryMb: mem, cpus };
}

/** The image ID a tag holds here now, or null (central sends what is missing or different: image-load). */
async function hasImageOp(msg: Message) {
  const image = String(msg.image ?? '');
  if (!IMAGE.test(image)) throw new Error('refused: bad image');
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** The names an image central sends may load under: a stack's image, or NanoClaw's helper. */
export const LOADABLE = /^(nc-[a-z0-9_.-]{1,160}:(pulled|built)|nanoclaw-workload-helper:[a-z0-9]{1,16})$/;
const MAX_META = 1024 * 1024;

/**
 * The image names a `docker save` archive would load under: manifest.json's
 * RepoTags, the legacy repositories file, and index.json's name annotations.
 * Reads only tar headers and those small files.
 */
export function archiveNames(file: string): { names: string[]; manifest: boolean } {
  const fd = fs.openSync(file, 'r');
  const names: string[] = [];
  let manifest = false;
  try {
    const size = fs.fstatSync(fd).size;
    const h = Buffer.alloc(512);
    let pos = 0;
    let longName: string | null = null;
    while (pos + 512 <= size) {
      fs.readSync(fd, h, 0, 512, pos);
      if (h.every((b) => b === 0)) break;
      const field = (o: number, n: number) =>
        h
          .subarray(o, o + n)
          .toString('latin1')
          .replace(/\0.*$/s, '');
      const len = parseInt(field(124, 12).trim() || '0', 8);
      if (!Number.isFinite(len) || len < 0) throw new Error('bad archive');
      const type = String.fromCharCode(h[156] || 48);
      const prefix = field(345, 155);
      let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = null;
      const body = (): string => {
        if (len > MAX_META) throw new Error('bad archive');
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, pos + 512);
        return b.toString('utf8');
      };
      if (type === 'L') longName = body().replace(/\0.*$/s, '');
      else if (type === 'x') {
        const m = /\d+ path=([^\n]*)\n/.exec(body());
        if (m) longName = m[1];
      } else {
        name = name.replace(/^\.\//, '');
        if (name === 'manifest.json') {
          manifest = true;
          const list = JSON.parse(body()) as Array<{ RepoTags?: unknown }>;
          if (!Array.isArray(list)) throw new Error('bad manifest');
          for (const e of list) for (const t of Array.isArray(e?.RepoTags) ? e.RepoTags : []) names.push(String(t));
        } else if (name === 'repositories') {
          const repos = JSON.parse(body()) as Record<string, Record<string, unknown>>;
          for (const [repo, tags] of Object.entries(repos ?? {}))
            for (const tag of Object.keys(tags ?? {})) names.push(`${repo}:${tag}`);
        } else if (name === 'index.json') {
          const idx = JSON.parse(body()) as { manifests?: Array<{ annotations?: Record<string, unknown> }> };
          for (const m of idx?.manifests ?? []) {
            const n = m?.annotations?.['io.containerd.image.name'];
            if (n !== undefined) names.push(String(n).replace(/^docker\.io\/library\//, ''));
          }
        }
      }
      pos += 512 + Math.ceil(len / 512) * 512;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { names, manifest };
}

/** Why an archive must not be loaded as `image`, or null: it may only name that image. */
export function refuseArchive(file: string, image: string): string | null {
  let found: { names: string[]; manifest: boolean };
  try {
    found = archiveNames(file);
  } catch (err) {
    return `not an image archive (${(err as Error).message})`;
  }
  if (!found.manifest) return 'not an image archive (no manifest.json)';
  const other = found.names.find((n) => n !== image);
  if (other) return `the archive would also load ${other.slice(0, 200)}`;
  if (!found.names.includes(image)) return `the archive does not hold ${image}`;
  return null;
}

/**
 * An image central sends (docker save), under a name NanoClaw owns. It is
 * written to this machine's work folder first, and loaded only when every
 * name in it is that one, so it can never re-tag an image something else on
 * this machine uses. Nothing else is run.
 */
function onImageLoad(meta: Record<string, unknown>, stream: Duplex): void {
  const image = String(meta.image ?? '');
  if (!LOADABLE.test(image)) return void stream.destroy(new Error('refused: not a NanoClaw image name'));
  const file = path.join(WORK, `image-${crypto.randomBytes(8).toString('hex')}.tar`);
  let out: fs.WriteStream;
  try {
    fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
    out = fs.createWriteStream(file, { mode: 0o600, flags: 'wx' });
  } catch (err) {
    return void stream.destroy(err as Error);
  }
  const drop = () => fs.rmSync(file, { force: true });
  stream.on('error', () => (out.destroy(), drop()));
  out.on('error', (e) => (drop(), stream.destroy(e)));
  stream.pipe(out);
  out.on('finish', () => {
    const why = refuseArchive(file, image);
    if (why) return void (drop(), stream.destroy(new Error(`refused: ${why}`)));
    void run('docker', ['load', '--quiet', '--input', file], { timeoutMs: 1_200_000 }).then((r) => {
      drop();
      if (r.code === 0) stream.end();
      else stream.destroy(new Error(r.stderr.trim() || `exit ${r.code}`));
    });
  });
}

// ── files and volumes as streams ──────────────────────────────────────────────

/** `docker run --rm -i` of the helper image with fixed limits and no network. */
function helper(args: string[]) {
  return spawn(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--network',
      'none',
      '--log-driver',
      'none',
      '--memory',
      '512m',
      '--pids-limit',
      '64',
      '--security-opt',
      'no-new-privileges:true',
      ...args,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

/** Wire a helper to a link stream: `into` feeds the stream to its stdin, else its stdout feeds the stream. */
function pipeHelper(stream: Duplex, p: ReturnType<typeof helper>, into: boolean): void {
  let err = '';
  p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
  p.on('error', (e) => stream.destroy(e));
  if (into) {
    p.stdin.on('error', () => undefined);
    stream.pipe(p.stdin);
    p.stdout.resume();
  } else {
    p.stdin.end();
    p.stdout.pipe(stream, { end: false });
  }
  stream.on('error', () => p.kill('SIGKILL'));
  p.on('close', (code) => (code === 0 ? stream.end() : stream.destroy(new Error(err.trim() || `exit ${code}`))));
}

function volumeOk(project: unknown, volume: unknown): boolean {
  return (
    typeof project === 'string' &&
    NAME.test(project) &&
    typeof volume === 'string' &&
    volume.startsWith(`${project}_`) &&
    /^[A-Za-z0-9_.-]{1,200}$/.test(volume)
  );
}

/** A volume as a tar stream, out (backup) or in (restore), in a throwaway helper container. */
function onVolumeStream(meta: Record<string, unknown>, stream: Duplex): void {
  if (!IMAGE.test(String(meta.image ?? ''))) return void stream.destroy(new Error('refused: bad image'));
  if (!volumeOk(meta.project, meta.volume))
    return void stream.destroy(new Error('refused: not a volume of that project'));
  const image = String(meta.image);
  if (meta.kind === 'vol-out')
    return pipeHelper(
      stream,
      helper(['-v', `${String(meta.volume)}:/v:ro`, image, 'tar', 'czf', '-', '-C', '/v', '.']),
      false,
    );
  return pipeHelper(
    stream,
    helper(['-v', `${String(meta.volume)}:/v`, image, 'sh', '-c', 'find /v -mindepth 1 -delete && tar xzf - -C /v']),
    true,
  );
}

async function volumesOp(msg: Message) {
  const project = String(msg.project ?? '');
  if (!NAME.test(project)) throw new Error('refused: bad project');
  const r = await run('docker', [
    'volume',
    'ls',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    '{{.Name}}\t{{.Label "com.docker.compose.volume"}}',
  ]);
  if (r.code !== 0) throw new Error(r.stderr.slice(0, 300));
  return r.stdout;
}

function rmdirOp(msg: Message) {
  if (typeof msg.dir !== 'string' || !DIR.test(msg.dir)) throw new Error('refused: bad folder');
  fs.rmSync(path.join(WORK, 'wl', msg.dir), { recursive: true, force: true });
  return null;
}

// ── health (as report.sh measures it) ─────────────────────────────────────────

let prevCpu: { tot: number; idle: number; nc: number; at: number } | null = null;

export function health(read: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')) {
  const mem = Object.fromEntries(
    read('/proc/meminfo')
      .split('\n')
      .map((l) => l.match(/^(\w+):\s+(\d+)/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], Number(m[2])]),
  ) as Record<string, number>;
  const total = Math.floor((mem.MemTotal ?? 0) / 1024);
  const used = total - Math.floor((mem.MemAvailable ?? 0) / 1024);
  let ncMem = 0;
  let ncUsec = 0;
  let slices: string[] = [];
  try {
    slices = fs.readdirSync('/sys/fs/cgroup').filter((n) => /^nanoclaw.*\.slice$/.test(n));
  } catch {
    /* no cgroup v2 here */
  }
  for (const s of slices) {
    try {
      ncMem += Math.floor(Number(read(`/sys/fs/cgroup/${s}/memory.current`)) / 1048576);
      const m = read(`/sys/fs/cgroup/${s}/cpu.stat`).match(/usage_usec (\d+)/);
      if (m) ncUsec += Number(m[1]);
    } catch {
      /* a slice without controllers */
    }
  }
  const cpus = os.cpus().length;
  const f = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
  const tot = f.reduce((a, b) => a + b, 0);
  const idle = (f[3] ?? 0) + (f[4] ?? 0);
  const now = Date.now();
  let cpuUsed = 0;
  let cpuNc = 0;
  if (prevCpu) {
    const dt = tot - prevCpu.tot;
    if (dt > 0) cpuUsed = ((dt - (idle - prevCpu.idle)) / dt) * cpus;
    const ds = (now - prevCpu.at) / 1000;
    if (ds > 0) cpuNc = Math.max(0, (ncUsec - prevCpu.nc) / (ds * 1_000_000));
  }
  prevCpu = { tot, idle, nc: ncUsec, at: now };
  let diskTotalGb = 0;
  let diskFreeGb = 0;
  try {
    const st = fs.statfsSync('/');
    diskTotalGb = Math.floor((st.blocks * st.bsize) / 2 ** 30);
    diskFreeGb = Math.floor((st.bavail * st.bsize) / 2 ** 30);
  } catch {
    /* Node before 18.15 */
  }
  return {
    cpus,
    memTotalMb: total,
    memUsedMb: used,
    memNanoclawMb: ncMem,
    cpuUsed: Math.round(cpuUsed * 100) / 100,
    cpuNanoclaw: Math.round(cpuNc * 100) / 100,
    diskTotalGb,
    diskFreeGb,
    load1: os.loadavg()[0],
    agentVersion: WORKER_VERSION,
    isolation: isolation.state,
    isolationAgeMs: Math.max(0, now - isolation.at),
  };
}

// ── the link ──────────────────────────────────────────────────────────────────

export interface WorkerConfig {
  host: string;
  port: number;
  pin: string;
  key: string;
  cert: string;
}

export function readConfig(dir = CONF_DIR): WorkerConfig {
  const conf = Object.fromEntries(
    fs
      .readFileSync(path.join(dir, 'config'), 'utf8')
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return {
    host: conf.HOST,
    port: Number(conf.PORT),
    pin: conf.PIN,
    key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'),
    cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'),
  };
}

/** sha256 of the peer's public key, as curl's --pinnedpubkey spells it (base64). */
const pinOf = (raw: Buffer): string =>
  crypto
    .createHash('sha256')
    .update(new crypto.X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');

/** Connect, check central's pinned key, and switch the connection to the link. */
export function connect(cfg: WorkerConfig): Promise<Mux> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: cfg.host,
      port: cfg.port,
      key: cfg.key,
      cert: cfg.cert,
      rejectUnauthorized: false,
    });
    const fail = (err: Error) => {
      sock.destroy();
      reject(err);
    };
    sock.once('error', fail);
    sock.setTimeout(20_000, () => fail(new Error('timed out')));
    sock.once('secureConnect', () => {
      const peer = sock.getPeerCertificate(true);
      if (!peer?.raw || pinOf(peer.raw) !== cfg.pin) return fail(new Error("central's key does not match the pin"));
      sock.write(`GET /link HTTP/1.1\r\nHost: ${cfg.host}\r\nUpgrade: nanoclaw-link\r\nConnection: Upgrade\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onData = (c: Buffer) => {
        head = Buffer.concat([head, c]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length > 8192) fail(new Error('bad answer'));
          return;
        }
        sock.off('data', onData);
        const status = head.subarray(0, head.indexOf('\r\n')).toString();
        if (!/^HTTP\/1\.1 101/.test(status)) return fail(new Error(`central refused the link: ${status}`));
        sock.setTimeout(0);
        sock.off('error', fail);
        const mux = new Mux(sock, 'worker');
        const rest = head.subarray(end + 4);
        if (rest.length) sock.emit('data', rest);
        resolve(mux);
      };
      sock.on('data', onData);
    });
  });
}

/** Wire the fixed set of jobs onto a link. */
export function serve(mux: Mux): void {
  mux.handle('info', async () => ({
    version: WORKER_VERSION,
    node: process.version,
    docker: (await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 })).stdout.trim(),
  }));
  mux.handle('docker', dockerOp);
  mux.handle('slice', sliceOp);
  mux.handle('rmdir', rmdirOp);
  mux.handle('hasImage', hasImageOp);
  mux.handle('volumes', volumesOp);
  mux.handle('probe', async (msg) => ({ isolation: await runProbe(String(msg.image ?? '')), ...isolationNow() }));
  mux.onStream((meta, stream) => {
    if (meta.kind === 'image-load') return onImageLoad(meta, stream);
    if (meta.kind === 'vol-out' || meta.kind === 'vol-in') return onVolumeStream(meta, stream);
    if (meta.kind !== 'tcp') return void stream.destroy(new Error('refused: unknown stream'));
    const refuse = () => void stream.destroy(new Error("refused: only a workload service's own address"));
    // The address's shape first (never .1, only the service range), then whether a service of ours holds it.
    if (!tcpAllowed(meta.host, meta.port, new Set([String(meta.host)]))) return refuse();
    stream.on('error', () => undefined);
    void heldAddresses()
      .catch(() => new Set<string>())
      .then((held) => {
        if (!tcpAllowed(meta.host, meta.port, held)) return refuse();
        const up = net.connect({ host: String(meta.host), port: Number(meta.port) });
        up.on('error', (err) => stream.destroy(err));
        stream.on('error', () => up.destroy());
        stream.pipe(up);
        up.pipe(stream);
      });
  });
}

async function main(): Promise<void> {
  // The isolation check at start (with the image central sent before) and every half hour.
  void runProbe();
  setInterval(() => void runProbe(), PROBE_EVERY_MS).unref();
  let backoff = 2000;
  for (;;) {
    try {
      const mux = await connect(readConfig());
      backoff = 2000;
      serve(mux);
      console.log('Linked to NanoClaw');
      const beat = () => mux.send({ t: 'health', data: health() });
      beat();
      const timer = setInterval(beat, 60_000);
      const recycle = setTimeout(() => mux.close(new Error('recycle')), RECYCLE_MS);
      await new Promise((r) => mux.once('close', r));
      clearInterval(timer);
      clearTimeout(recycle);
      console.log('Link closed');
    } catch (err) {
      console.error(`Link failed: ${(err as Error).message}`);
    }
    if (fs.existsSync(path.join(CONF_DIR, 'revoked'))) {
      console.log('This machine was revoked; stopping.');
      return;
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 60_000);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) void main();
