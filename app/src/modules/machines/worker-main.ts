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

export const WORKER_VERSION = '5';
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
    if ((sub === 'create' || sub === 'rm') && NAME.test(a.at(-1) ?? '')) return null;
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
    for (const [name, text] of Object.entries(files)) {
      if (!COMPOSE_FILES.has(name) || typeof text !== 'string') throw new Error('refused: bad file');
      fs.writeFileSync(path.join(cwd, name), text, { mode: 0o600 });
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

/** An image central sends (docker save): loaded as is; nothing else is run. */
function onImageLoad(meta: Record<string, unknown>, stream: Duplex): void {
  if (!IMAGE.test(String(meta.image ?? ''))) return void stream.destroy(new Error('refused: bad image'));
  const p = spawn('docker', ['load', '--quiet'], {
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/root' },
  });
  let err = '';
  p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
  p.on('error', (e) => stream.destroy(e));
  p.stdin.on('error', () => undefined);
  stream.pipe(p.stdin);
  p.stdout.resume();
  stream.on('error', () => p.kill('SIGKILL'));
  p.on('close', (code) => (code === 0 ? stream.end() : stream.destroy(new Error(err.trim() || `exit ${code}`))));
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
