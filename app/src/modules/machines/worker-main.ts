/**
 * The worker service (Scaling phase 3): runs on a machine with the worker
 * role, as root under systemd, on the machine's own Node (18 or later). It
 * keeps ONE mutual-TLS link to central (mux.ts) with the machine's key and
 * certificate from joining, and does only what central asks from a fixed set:
 *
 *   docker   a `docker` command from an allowlist (Compose for NanoClaw's
 *            projects, networks and images it names), with the Compose files
 *            central sends, in this worker's own folder
 *   slice    size the workloads systemd slice to NanoClaw's share of this machine
 *   rmdir    remove a workload's folder
 *   tcp      a byte stream to a workload's address (198.18.0.0/15) on this machine
 *
 * There is no general shell. Health goes to central every minute over the link.
 * Built-ins only (and ./mux.js): it is served by central and run as is.
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';

import { Mux, type Message } from './mux.js';

export const WORKER_VERSION = '2';
const CONF_DIR = process.env.NC_MACHINE_DIR || '/etc/nanoclaw-machine';
const WORK = process.env.NC_WORKER_DIR || '/var/lib/nanoclaw-worker';
const MAX_OUT = 20_000;
/** Reconnect this often, so a renewed certificate is used. */
const RECYCLE_MS = 12 * 3600_000;

// ── what central may ask ──────────────────────────────────────────────────────

const COMPOSE_SUB = new Set([
  'up',
  'down',
  'pull',
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
  const why = refuseDocker(msg.args);
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
  mux.onStream((meta, stream) => {
    const port = Number(meta.port);
    if (meta.kind !== 'tcp' || !workloadAddress(meta.host) || !Number.isInteger(port) || port < 1 || port > 65535)
      return void stream.destroy(new Error('refused: only workload addresses'));
    const up = net.connect({ host: String(meta.host), port });
    up.on('error', (err) => stream.destroy(err));
    stream.on('error', () => up.destroy());
    stream.pipe(up);
    up.pipe(stream);
  });
}

async function main(): Promise<void> {
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
