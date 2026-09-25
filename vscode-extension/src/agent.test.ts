import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefusedError, RunnerAgent, effectiveImagePolicy, type ImagePolicy } from './agent.js';
import type { Cli } from './docker.js';
import { workspaceFor, workspaceRecords } from './git-changes.js';
import { LOCK_LABEL, RELAY_SENTINEL, type BundleDoc, type RemoteSpec } from './remote-spec.js';

// Pack the way central does: gzip(JSON(doc)), hash = sha256 of the gz bytes, base64 chunks.
function pack(
  files: Record<string, string>,
  dirs: string[] = [],
): { hash: string; chunks: Array<{ hash: string; seq: number; total: number; data: string }> } {
  const doc: BundleDoc = {
    v: 1,
    dirs,
    files: Object.entries(files).map(([p, c]) => ({ p, m: 0o644, d: Buffer.from(c).toString('base64') })),
    skipped: [],
  };
  const gz = gzipSync(Buffer.from(JSON.stringify(doc)));
  const hash = createHash('sha256').update(gz).digest('hex');
  const b64 = gz.toString('base64');
  const size = Math.max(8, Math.ceil(b64.length / 3));
  const chunks = [];
  for (let i = 0, seq = 0; i < b64.length; i += size, seq++)
    chunks.push({ hash, seq, total: Math.ceil(b64.length / size), data: b64.slice(i, i + size) });
  return { hash, chunks };
}

class FakeCli implements Cli {
  calls: string[][] = [];
  images = new Set<string>();
  imageLabels = new Map<string, string>();
  pullExit = 0;
  containers = new Map<string, { labels: Record<string, string>; state: string }>();
  waits: Array<{ name: string; resolve: (c: number) => void; emit: (line: string) => void }> = [];
  buildExit = 0;
  logLines: string[] = [];
  execFails = false;
  /** Simulate podman's client losing its machine: every command fails with its wording. */
  runtimeDown = false;
  containerEnv = new Map<string, string[]>();
  containerNetwork = new Map<string, string>();
  containerMounts = new Map<string, string[]>();
  containerMountSources = new Map<string, Map<string, string>>();
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    const [cmd] = args;
    if (this.runtimeDown)
      throw new Error('Cannot connect to Podman. Please verify your connection to the Linux system');
    if (cmd === 'run') return '{"requeued":2}';
    if (cmd === 'image') {
      const ref = args[args.length - 1];
      if (!this.images.has(ref)) throw new Error('Error: No such image');
      // Label inspect: both runtimes print a placeholder when the key is absent.
      if (args.some((a) => a.includes('Config.Labels'))) return this.imageLabels.get(ref) ?? '<no value>';
      return 'sha256:abc';
    }
    if (cmd === 'tag') {
      this.images.add(args[2]);
      this.imageLabels.set(args[2], this.imageLabels.get(args[1]) ?? '');
      return '';
    }
    if (cmd === 'inspect') {
      const name = args[args.length - 1];
      const c = this.containers.get(name);
      if (!c) throw new Error('Error: No such object');
      const fmt = args[2];
      if (args.some((a) => a.includes('Config.Env'))) {
        const env = JSON.stringify(this.containerEnv.get(name) ?? []);
        return fmt.includes('NetworkMode') ? `${env}|${this.containerNetwork.get(name) ?? 'none'}` : env;
      }
      if (fmt.includes('.State.Status')) return `${c.state}|0`;
      if (fmt.includes('.Config.Image')) return 'nanoclaw-agent-v2-x:latest';
      if (fmt.includes('.Mounts')) {
        const srcs = this.containerMountSources.get(name) ?? new Map<string, string>();
        return (
          (this.containerMounts.get(name) ?? [])
            .map((d) => (fmt.includes('.Source') ? `${d}\t${srcs.get(d) ?? ''}` : d))
            .join('\n') + '\n'
        );
      }
      return `${c.labels['nanoclaw-install']}|${c.labels['nanoclaw-group']}|${c.labels['nanoclaw-session']}`;
    }
    if (cmd === 'create') {
      const name = args[3];
      const labels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++)
        if (args[i] === '--label') {
          const [k, v] = args[i + 1].split('=');
          labels[k] = v;
        }
      this.containerEnv.set(
        name,
        args.filter((_, i) => args[i - 1] === '-e'),
      );
      const ni = args.indexOf('--network');
      this.containerNetwork.set(name, ni >= 0 ? args[ni + 1] : 'bridge');
      const vols = args.filter((_, i) => args[i - 1] === '-v');
      this.containerMounts.set(
        name,
        vols.map((v) => v.split(':')[1]),
      );
      this.containerMountSources.set(name, new Map(vols.map((v) => [v.split(':')[1], v.split(':')[0]])));
      this.containers.set(name, { labels, state: 'created' });
      return name;
    }
    if (cmd === 'stop') {
      const c = this.containers.get(args[args.length - 1]);
      if (!c) throw new Error('Error: No such container');
      c.state = 'exited';
      return '';
    }
    if (cmd === 'rm') {
      this.containers.delete(args[args.length - 1]);
      return '';
    }
    if (cmd === 'exec') {
      if (this.execFails) throw new Error('exec failed');
      return '';
    }
    if (cmd === 'logs') {
      if (!this.containers.has(args[args.length - 1])) throw new Error('Error: No such container');
      return this.logLines.join('\n');
    }
    if (cmd === 'ps')
      return [...this.containers]
        .map(([n, c]) => `${n}|${c.state}|${c.labels['nanoclaw-group']}|${c.labels['nanoclaw-session']}`)
        .join('\n');
    throw new Error(`fake cli: ${args.join(' ')}`);
  }
  lastWrites: string[] = [];
  start(args: string[], onLine?: (l: string) => void) {
    this.calls.push(args);
    if (args[0] === 'build') {
      onLine?.('Step 1/2');
      if (this.buildExit === 0) this.images.add(args[2]);
      return { done: Promise.resolve(this.buildExit), kill: () => {}, write: () => {} };
    }
    if (args[0] === 'pull') {
      onLine?.('Trying to pull…');
      if (this.pullExit === 0) this.images.add(args[1]);
      return { done: Promise.resolve(this.pullExit), kill: () => {}, write: () => {} };
    }
    if (args[0] === 'start' && args[1] === '--attach') {
      const c = this.containers.get(args[2]);
      if (c) c.state = 'running';
      let resolve!: (c: number) => void;
      const done = new Promise<number | null>((r) => {
        resolve = r;
      });
      this.waits.push({ name: args[2], resolve, emit: (l: string) => onLine?.(l) });
      return { done, kill: () => {}, write: () => {} };
    }
    if (args[0] === 'exec')
      return {
        done: new Promise<number | null>(() => {}),
        kill: () => {},
        write: (w: string) => this.lastWrites.push(w),
      };
    return { done: Promise.resolve(0), kill: () => {}, write: (w: string) => this.lastWrites.push(w) };
  }
}

let tmp: string;
let cli: FakeCli;
let sent: Array<Record<string, unknown>>;
let logs: string[];
let slots: Record<string, string>;
let allowlist: string[];
const agent = (imagePolicy?: () => ImagePolicy) =>
  new RunnerAgent({
    cli,
    runtime: 'docker',
    storageRoot: path.join(tmp, 'runner'),
    policy: () => ({ slots, allowlist }),
    ...(imagePolicy ? { imagePolicy } : {}),
    send: (f) => sent.push(f),
    log: (l) => logs.push(l),
    platform: 'linux',
    heartbeatMs: 30,
  });
const pullPolicy = (over: Partial<ImagePolicy> = {}): ImagePolicy => ({
  source: 'pull',
  ref: '',
  allowUnlabeled: false,
  ...over,
});

function spec(over: Partial<RemoteSpec> = {}): RemoteSpec {
  return {
    v: 1,
    key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
    name: 'ncl-spike-s1',
    labels: {},
    image: 'nanoclaw-agent-v2-x:latest',
    env: { HTTPS_PROXY: RELAY_SENTINEL },
    contributedEnv: {},
    command: ['bash', '-c'],
    args: ['x'],
    containerLabels: {},
    mounts: [],
    resources: {},
    hardening: 'standard',
    stopGraceSeconds: 1,
    network: 'default',
    ...over,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-agent-'));
  cli = new FakeCli();
  sent = [];
  logs = [];
  slots = {};
  allowlist = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('RunnerAgent', () => {
  it('have/bundle: reassembles chunks, verifies the hash, unpacks once', async () => {
    const a = agent();
    const b = pack({ 'index.ts': 'console.log(1)', 'sub/x.txt': 'x' }, ['sub']);
    expect(await a.handle('have', { hashes: [b.hash, 'f'.repeat(64)] })).toEqual({ missing: [b.hash, 'f'.repeat(64)] });
    for (const c of b.chunks.slice(0, -1)) expect(await a.handle('bundle', c)).toEqual({ complete: false });
    expect(await a.handle('bundle', b.chunks[b.chunks.length - 1])).toEqual({ complete: true });
    expect(await a.handle('have', { hashes: [b.hash] })).toEqual({ missing: [] });
    expect(fs.readFileSync(a.bundles.treePath(b.hash, false) + '/sub/x.txt', 'utf8')).toBe('x');
    const bad = { ...b.chunks[0], hash: 'a'.repeat(64), total: 1, data: b.chunks.map((c) => c.data).join('') };
    await expect(a.handle('bundle', bad)).rejects.toThrow(/hash mismatch/);
  });

  it('prepare: builds a missing image from the shipped context, resolves every mount kind, creates the container', async () => {
    const a = agent();
    const build = pack({ Dockerfile: 'FROM scratch' });
    const src = pack({ 'index.ts': 'x' });
    const cfg = pack({ 'container.json': '{}' });
    const seed = pack({ 'inbound.db': 'db' }, ['outbox']);
    for (const b of [build, src, cfg, seed]) for (const c of b.chunks) await a.handle('bundle', c);
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    slots = { '/workspace/extra/agent': proj };
    allowlist = [tmp];
    const s = spec({
      build: { bundle: build.hash, args: { IMAGE_SOURCE: 'runner' } },
      mounts: [
        {
          kind: 'state',
          class: 'group-state',
          containerPath: '/workspace',
          stateId: 'data/v2-sessions/g1/s1',
          seed: seed.hash,
        },
        {
          kind: 'content',
          class: 'group-state',
          containerPath: '/workspace/agent/container.json',
          bundle: cfg.hash,
          file: true,
        },
        { kind: 'content', class: 'install-surface', containerPath: '/app/src', bundle: src.hash, file: false },
        { kind: 'slot', class: 'allowlisted-extra', containerPath: '/workspace/extra/agent', mode: 'rw' },
      ],
    });
    expect(await a.handle('prepare', { spec: s })).toEqual({ name: 'ncl-spike-s1' });
    const build_ = cli.calls.find((c) => c[0] === 'build')!;
    expect(build_.slice(0, 5)).toEqual([
      'build',
      '-t',
      'nanoclaw-agent-v2-x:latest',
      '--build-arg',
      'IMAGE_SOURCE=runner',
    ]);
    const create = cli.calls.find((c) => c[0] === 'create')!;
    const vols = create.filter((_, i) => create[i - 1] === '-v');
    const stateDir = path.join(tmp, 'runner', 'state', 'data', 'v2-sessions', 'g1', 's1');
    expect(vols[0]).toBe(`${stateDir}:/workspace`);
    expect(vols[1]).toMatch(/\/tree\/container\.json:\/workspace\/agent\/container\.json:ro$/);
    expect(vols[2]).toMatch(/\/tree:\/app\/src:ro$/);
    expect(vols[3]).toBe(`${fs.realpathSync(proj)}:/workspace/extra/agent`);
    expect(fs.readFileSync(path.join(stateDir, 'inbound.db'), 'utf8')).toBe('db'); // seeded once
    expect(fs.existsSync(path.join(stateDir, 'outbox'))).toBe(true);
    // The relay lives inside the container now, so the proxy is a constant on
    // its own loopback — nothing on the host, nothing to resolve.
    expect(create).toContain('HTTPS_PROXY=http://127.0.0.1:18080');
    a.dispose();
    // idempotent on key: same spec again reuses the container, no second create
    expect(await a.handle('prepare', { spec: s })).toEqual({ name: 'ncl-spike-s1', reused: true });
    expect(cli.calls.filter((c) => c[0] === 'create')).toHaveLength(1);
  });

  it('refuses an unbound slot, a slot outside the allowlist, and an unknown spec version', async () => {
    const a = agent();
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const slot = {
      kind: 'slot' as const,
      class: 'allowlisted-extra' as const,
      containerPath: '/workspace/extra/agent',
      mode: 'rw' as const,
    };
    await expect(a.handle('prepare', { spec: spec({ mounts: [slot] }) })).rejects.toMatchObject({
      failure: { kind: 'denied-by-policy' },
    });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-outside-'));
    try {
      slots = { '/workspace/extra/agent': outside };
      allowlist = [tmp];
      await expect(a.handle('prepare', { spec: spec({ mounts: [slot] }) })).rejects.toThrow(
        /outside the mount allowlist/,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    await expect(a.handle('prepare', { spec: spec({ v: 2 }) })).rejects.toBeInstanceOf(RefusedError);
    expect(cli.calls.some((c) => c[0] === 'create')).toBe(false);
  });

  it('start emits a phase event, heartbeats while running, and a terminal event when the container exits', async () => {
    const a = agent();
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const s = spec({
      mounts: [{ kind: 'state', class: 'group-state', containerPath: '/workspace', stateId: 'data/v2-sessions/g1/s1' }],
    });
    await a.handle('prepare', { spec: s });
    await a.handle('start', { name: 'ncl-spike-s1', key: s.key });
    expect(sent[0]).toEqual({ type: 'event', key: s.key, kind: 'phase' });
    fs.writeFileSync(path.join(tmp, 'runner/state/data/v2-sessions/g1/s1/.heartbeat'), '');
    await new Promise((r) => setTimeout(r, 80));
    const hb = sent.find((f) => f.type === 'heartbeat') as { key: unknown; mtimeMs: number };
    expect(hb.key).toEqual(s.key);
    expect(typeof hb.mtimeMs).toBe('number');
    expect(await a.handle('status', { name: 'ncl-spike-s1' })).toEqual({ state: 'running', exitCode: 0 });
    expect(await a.handle('list', { installSlug: 'spike' })).toEqual({
      sessions: [{ name: 'ncl-spike-s1', state: 'running', phase: 'running', key: s.key }],
    });
    // A crash at boot explains itself through the attach channel, not through
    // an exit code alone — that was the 'wait rc 125' blind spot.
    cli.waits[0].emit('Error: Cannot find module /app/src/index.ts');
    cli.containers.delete('ncl-spike-s1'); // --rm removes it the moment it dies
    cli.waits[0].resolve(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.some((f) => f.type === 'event' && f.kind === 'terminal')).toBe(true);
    expect(logs.some((l) => l.includes('exited 1: Error: Cannot find module'))).toBe(true);
    expect(await a.handle('stop', { name: 'ncl-spike-s1', reason: 't' })).toEqual({});
    expect(await a.handle('status', { name: 'nope' })).toEqual({ state: 'absent' });
    a.dispose();
  });
});

describe('RunnerAgent image source', () => {
  const LOCK = 'a'.repeat(64);
  const PIN = 'registry.example.com/nanoclaw/agent@sha256:' + 'b'.repeat(64);
  const pinned = (over: Partial<RemoteSpec> = {}) =>
    spec({ imageRef: PIN, build: { bundle: 'c'.repeat(64), args: {}, lockSha: LOCK }, ...over });

  it("pull: fetches central's pin, verifies the runtime it bakes, retags it to the name central chose", async () => {
    cli.imageLabels.set(PIN, LOCK);
    const a = agent(() => pullPolicy());
    expect(await a.handle('prepare', { spec: pinned() })).toEqual({ name: 'ncl-spike-s1' });
    expect(cli.calls.find((c) => c[0] === 'pull')).toEqual(['pull', PIN]);
    expect(cli.calls.find((c) => c[0] === 'tag')).toEqual(['tag', PIN, 'nanoclaw-agent-v2-x:latest']);
    expect(cli.calls.some((c) => c[0] === 'build')).toBe(false); // never falls back to building
    expect(cli.calls.some((c) => c[0] === 'create')).toBe(true);
  });

  it("pull: a configured reference overrides central's pin (corporate mirror)", async () => {
    const MIRROR = 'registry.example.org/nanoclaw/agent@sha256:' + 'd'.repeat(64);
    cli.imageLabels.set(MIRROR, LOCK);
    const a = agent(() => pullPolicy({ ref: MIRROR }));
    await a.handle('prepare', { spec: pinned() });
    expect(cli.calls.find((c) => c[0] === 'pull')).toEqual(['pull', MIRROR]);
  });

  it('pull: refuses an image that bakes a different agent-runner, or none at all', async () => {
    cli.imageLabels.set(PIN, 'e'.repeat(64)); // built from another checkout
    await expect(agent(() => pullPolicy()).handle('prepare', { spec: pinned() })).rejects.toMatchObject({
      failure: { kind: 'denied-by-policy' },
    });
    cli.images.clear();
    cli.imageLabels.clear(); // unlabeled image
    await expect(agent(() => pullPolicy()).handle('prepare', { spec: pinned() })).rejects.toThrow(
      new RegExp(LOCK_LABEL),
    );
    cli.images.clear();
    const a = agent(() => pullPolicy({ allowUnlabeled: true }));
    expect(await a.handle('prepare', { spec: pinned() })).toEqual({ name: 'ncl-spike-s1' });
  });

  it('pull: allowing unlabeled images never admits a mislabeled one', async () => {
    cli.imageLabels.set(PIN, 'e'.repeat(64));
    await expect(
      agent(() => pullPolicy({ allowUnlabeled: true })).handle('prepare', { spec: pinned() }),
    ).rejects.toMatchObject({
      failure: { kind: 'denied-by-policy' },
    });
    expect(cli.calls.some((c) => c[0] === 'tag' || c[0] === 'create')).toBe(false);
  });

  it('adopting a running container re-attaches the relay forwarder (a reload killed the old one)', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const sp = spec({ mounts: [] });
    const a = agent();
    await a.handle('prepare', { spec: sp });
    await a.handle('start', { name: 'ncl-spike-s1', key: sp.key });
    await new Promise((r) => setTimeout(r, 30));
    a.dispose();
    cli.calls.length = 0;
    // New extension host, same container still running: the forwarder must come back on adoption alone.
    const b = agent();
    expect(await b.handle('prepare', { spec: sp })).toEqual({ name: 'ncl-spike-s1', reused: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(cli.calls.some((c) => c[0] === 'exec' && c[1] === '-i' && c[3] === 'bun')).toBe(true);
    b.dispose();
  });

  it('a container created without a usable relay port is recreated rather than adopted', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const a = agent();
    const sp = spec({ mounts: [] });
    await a.handle('prepare', { spec: sp });
    // Simulate a container from before the relay existed: a placeholder port.
    cli.containerEnv.set('ncl-spike-s1', ['HTTPS_PROXY=http://host.docker.internal:1']);
    const b = agent();
    expect(await b.handle('prepare', { spec: sp })).toEqual({ name: 'ncl-spike-s1' }); // recreated, not reused
    expect(cli.calls.some((c) => c[0] === 'rm')).toBe(true);
    expect(logs.some((l) => l.includes('predates the in-container relay'))).toBe(true);
    a.dispose();
    b.dispose();
  });

  it('a container lacking a mount central now declares is recreated with it (the workspace slot arrives later)', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    slots = { '/workspace/project': proj };
    allowlist = [tmp];
    const a = agent();
    await a.handle('prepare', { spec: spec({ mounts: [] }) });
    expect(cli.containerMounts.get('ncl-spike-s1')).toEqual([]);
    // Central re-prepares the same session, now declaring the developer's workspace.
    const withSlot = spec({
      mounts: [{ kind: 'slot', class: 'allowlisted-extra', containerPath: '/workspace/project', mode: 'rw' }],
    });
    const b = agent();
    expect(await b.handle('prepare', { spec: withSlot })).toEqual({ name: 'ncl-spike-s1' }); // recreated, not reused
    expect(
      logs.some((l) => l.includes('lacks a mount central now declares (/workspace/project, /workspace/project/.git')),
    ).toBe(true);
    expect(cli.containerMounts.get('ncl-spike-s1')).toEqual([
      '/workspace/project',
      '/workspace/project/.git',
      '/workspace/project/.vscode',
    ]);
    expect(logs.some((l) => l.includes(`slot /workspace/project ← ${fs.realpathSync(proj)} (rw)`))).toBe(true);
    // Same spec again: adopted, nothing recreated.
    cli.calls.length = 0;
    const c = agent();
    expect(await c.handle('prepare', { spec: withSlot })).toEqual({ name: 'ncl-spike-s1', reused: true });
    expect(cli.calls.some((x) => x[0] === 'rm')).toBe(false);
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('a slot in propose mode binds a self-contained clone of the repository, not the working tree', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    sh(['init', '-q']);
    sh(['config', 'user.email', 't@t']);
    sh(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'A\n');
    sh(['add', '-A']);
    sh(['commit', '-qm', 'init']);
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'uncommitted dev work\n'); // stays with the developer
    slots = { '/workspace/project': repo };
    allowlist = [tmp];
    const a = agent();
    await a.handle('prepare', {
      spec: spec({
        mounts: [
          { kind: 'slot', class: 'allowlisted-extra', containerPath: '/workspace/project', mode: 'rw', propose: true },
        ],
      }),
    });
    const create = cli.calls.find((c) => c[0] === 'create')!;
    const vol = create.filter((_, i) => create[i - 1] === '-v').find((v) => v.endsWith(':/workspace/project'))!;
    const bound = vol.slice(0, -':/workspace/project'.length);
    expect(bound).not.toBe(fs.realpathSync(repo));
    expect(bound.startsWith(path.join(tmp, 'runner', 'proposals'))).toBe(true);
    // The clone's git dir is outside the writable mount, and reaches the container read-only.
    expect(fs.existsSync(path.join(bound, '.git'))).toBe(false);
    const gitVol = create
      .filter((_, i) => create[i - 1] === '-v')
      .find((v) => v.endsWith(':/workspace/project/.git:ro'))!;
    const gitDir = gitVol.slice(0, -':/workspace/project/.git:ro'.length);
    expect(gitDir).toBe(a.currentProposal()?.gitDir);
    expect(path.relative(bound, gitDir).startsWith('..')).toBe(true);
    expect(fs.readFileSync(path.join(bound, 'a.txt'), 'utf8')).toBe('A\n');
    expect(fs.existsSync(path.join(bound, 'scratch.txt'))).toBe(false); // only committed files
    expect(a.currentProposal()?.repoRoot).toBe(fs.realpathSync(repo));
    expect(logs.some((l) => l.includes('proposal copy of'))).toBe(true);
    a.dispose();
  });

  it('hides secret-like paths inside a bound slot with empty read-only overlays (machine ∪ central patterns)', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const proj = path.join(tmp, 'proj');
    for (const f of ['src/app.ts', 'secrets/password.txt', '.env', 'deploy/prod.tfvars']) {
      fs.mkdirSync(path.dirname(path.join(proj, f)), { recursive: true });
      fs.writeFileSync(path.join(proj, f), 'x');
    }
    slots = { '/workspace/project': proj };
    allowlist = [tmp];
    const a = agent();
    const sp = spec({
      mounts: [
        {
          kind: 'slot',
          class: 'allowlisted-extra',
          containerPath: '/workspace/project',
          mode: 'rw',
          exclude: ['*.tfvars'],
        },
      ],
    });
    await a.handle('prepare', { spec: sp });
    const create = cli.calls.find((c) => c[0] === 'create')!;
    const vols = create.filter((_, i) => create[i - 1] === '-v');
    const real = fs.realpathSync(proj);
    expect(vols).toContain(`${real}:/workspace/project`);
    const empties = vols.filter((v) => v.includes(`${path.sep}empty${path.sep}`));
    expect(empties.map((v) => v.split(':').slice(1).join(':')).sort()).toEqual([
      '/workspace/project/.env:ro',
      '/workspace/project/.git:ro', // no repository: an empty one, so the agent cannot make one
      '/workspace/project/deploy/prod.tfvars:ro', // central's pattern
      '/workspace/project/secrets:ro',
    ]);
    expect(empties.find((v) => v.endsWith('/secrets:ro'))!.startsWith(path.join(tmp, 'runner', 'empty', 'dir'))).toBe(
      true,
    );
    expect(empties.find((v) => v.endsWith('/.env:ro'))!.startsWith(path.join(tmp, 'runner', 'empty', 'file'))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes('hiding 3 secret-like path(s) under /workspace/project'))).toBe(true);
    a.dispose();
  });

  it("direct mode mounts the workspace's .git read-only over the writable tree", async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const repo = path.join(tmp, 'direct');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
    slots = { '/workspace/project': repo };
    allowlist = [tmp];
    const a = agent();
    await a.handle('prepare', {
      spec: spec({
        mounts: [{ kind: 'slot', class: 'allowlisted-extra', containerPath: '/workspace/project', mode: 'rw' }],
      }),
    });
    const create = cli.calls.find((c) => c[0] === 'create')!;
    const vols = create.filter((_, i) => create[i - 1] === '-v');
    const real = fs.realpathSync(repo);
    expect(vols).toContain(`${real}:/workspace/project`);
    expect(vols).toContain(`${path.join(real, '.git')}:/workspace/project/.git:ro`);
    expect(vols.indexOf(`${path.join(real, '.git')}:/workspace/project/.git:ro`)).toBeGreaterThan(
      vols.indexOf(`${real}:/workspace/project`),
    );
    a.dispose();
  });

  it('direct mode keeps .vscode (made when missing) and an existing .devcontainer read-only, and records the repository', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const repo = path.join(tmp, 'editor');
    fs.mkdirSync(path.join(repo, '.devcontainer'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
    slots = { '/workspace/project': repo };
    allowlist = [tmp];
    const a = agent();
    await a.handle('prepare', {
      spec: spec({
        mounts: [{ kind: 'slot', class: 'allowlisted-extra', containerPath: '/workspace/project', mode: 'rw' }],
      }),
    });
    const create = cli.calls.find((c) => c[0] === 'create')!;
    const vols = create.filter((_, i) => create[i - 1] === '-v');
    const real = fs.realpathSync(repo);
    expect(vols).toEqual([
      `${real}:/workspace/project`,
      `${path.join(real, '.git')}:/workspace/project/.git:ro`,
      `${path.join(real, '.vscode')}:/workspace/project/.vscode:ro`,
      `${path.join(real, '.devcontainer')}:/workspace/project/.devcontainer:ro`,
    ]);
    expect(fs.statSync(path.join(real, '.vscode')).isDirectory()).toBe(true);
    const ws = await workspaceFor(workspaceRecords(path.join(tmp, 'runner')), real);
    expect(ws.repo).toEqual({ gitDir: path.join(real, '.git'), workTree: real });
    a.dispose();
  });

  it('direct mode without a .git of its own gets an empty read-only one, and the repository found before the mount is kept', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const repo = path.join(tmp, 'outer');
    const folder = path.join(repo, 'pkg');
    fs.mkdirSync(folder, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
    const loose = path.join(tmp, 'loose');
    fs.mkdirSync(loose);
    allowlist = [tmp];
    const mounts: RemoteSpec['mounts'] = [
      { kind: 'slot', class: 'allowlisted-extra', containerPath: '/workspace/project', mode: 'rw' },
    ];
    const records = workspaceRecords(path.join(tmp, 'runner'));
    for (const [dir, name] of [
      [folder, 'ncl-sub'],
      [loose, 'ncl-loose'],
    ] as const) {
      slots = { '/workspace/project': dir };
      const a = agent();
      await a.handle('prepare', { spec: spec({ name, mounts }) });
      const create = cli.calls.filter((c) => c[0] === 'create').pop()!;
      const vols = create.filter((_, i) => create[i - 1] === '-v');
      const gitVol = vols.find((v) => v.endsWith(':/workspace/project/.git:ro'))!;
      expect(gitVol.startsWith(path.join(tmp, 'runner', 'empty', 'dir'))).toBe(true);
      expect(vols.some((v) => v.endsWith(':/workspace/project/.vscode:ro'))).toBe(true);
      // The mountpoint is the developer's own, and git on the host passes over it.
      expect(fs.readdirSync(path.join(dir, '.git'))).toEqual([]);
      a.dispose();
    }
    expect((await workspaceFor(records, folder)).repo?.workTree).toBe(fs.realpathSync(repo));
    // An agent that got a .git in anyway (some other way) is still not the repository reviewed.
    execFileSync('git', ['init', '-q'], { cwd: folder, stdio: 'pipe' });
    execFileSync('git', ['init', '-q'], { cwd: loose, stdio: 'pipe' });
    expect((await workspaceFor(records, folder)).repo?.workTree).toBe(fs.realpathSync(repo));
    expect((await workspaceFor(records, loose)).repo).toBeNull();
  });

  it('direct mode refuses a .vscode that is a symbolic link', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const proj = path.join(tmp, 'linked');
    fs.mkdirSync(path.join(proj, 'elsewhere'), { recursive: true });
    fs.symlinkSync('elsewhere', path.join(proj, '.vscode'));
    slots = { '/workspace/project': proj };
    allowlist = [tmp];
    const a = agent();
    await expect(
      a.handle('prepare', {
        spec: spec({
          mounts: [{ kind: 'slot', class: 'allowlisted-extra', containerPath: '/workspace/project', mode: 'rw' }],
        }),
      }),
    ).rejects.toMatchObject({ failure: { kind: 'denied-by-policy' } });
    expect(cli.calls.some((c) => c[0] === 'create')).toBe(false);
    a.dispose();
  });

  it("a secret-like path whose name holds ':' is skipped (it cannot be a -v target) and said so", async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const proj = path.join(tmp, 'colon');
    fs.mkdirSync(proj);
    for (const f of ['.env', 'a:b.pem']) fs.writeFileSync(path.join(proj, f), 'x');
    slots = { '/workspace/project': proj };
    allowlist = [tmp];
    const a = agent();
    await a.handle('prepare', {
      spec: spec({
        mounts: [{ kind: 'slot', class: 'allowlisted-extra', containerPath: '/workspace/project', mode: 'rw' }],
      }),
    });
    const create = cli.calls.find((c) => c[0] === 'create')!;
    const vols = create.filter((_, i) => create[i - 1] === '-v');
    expect(vols.some((v) => v.includes('a:b.pem'))).toBe(false);
    expect(vols.some((v) => v.endsWith(':/workspace/project/.env:ro'))).toBe(true);
    expect(logs.filter((l) => l.includes("whose name contains ':'"))).toHaveLength(1);
    a.dispose();
  });

  it('a runtime that does not answer is a retryable pause on prepare — the live container is never removed', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const a = agent();
    const sp = spec({ mounts: [] });
    await a.handle('prepare', { spec: sp });
    cli.runtimeDown = true;
    await expect(a.handle('prepare', { spec: sp })).rejects.toMatchObject({
      failure: { kind: 'runtime-unavailable', retryable: true },
    });
    expect(cli.calls.some((c) => c[0] === 'rm')).toBe(false); // the podman outage that removed a working agent
    expect(cli.containers.has('ncl-spike-s1')).toBe(true);
    cli.runtimeDown = false;
    expect(await a.handle('prepare', { spec: sp })).toEqual({ name: 'ncl-spike-s1', reused: true });
    a.dispose();
  });

  it('a fresh start re-queues messages a dead container left in progress, once per container', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const a = agent();
    const sp = spec({
      mounts: [{ kind: 'state', class: 'group-state', containerPath: '/workspace', stateId: 'data/s1' }],
    });
    await a.handle('prepare', { spec: sp });
    await a.handle('start', { name: 'ncl-spike-s1', key: sp.key });
    const requeue = cli.calls.filter(
      (c) => c[0] === 'run' && c.includes('--network') && c.some((x) => x.includes('/workspace')),
    );
    expect(requeue).toHaveLength(1);
    expect(requeue[0].indexOf('--network')).toBeLessThan(requeue[0].indexOf('none') + 1);
    expect(logs.some((l) => l.includes('re-queued 2 message(s)'))).toBe(true);
    // A re-attach after a supervision drop is NOT a fresh start: no second requeue.
    await a.handle('start', { name: 'ncl-spike-s1', key: sp.key });
    expect(cli.calls.filter((c) => c[0] === 'run').length).toBe(1);
    a.dispose();
  });

  it('a container bound to the developer tree is recreated when the slot switches to propose mode', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const repo = path.join(tmp, 'repo2');
    fs.mkdirSync(repo);
    const sh = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    sh(['init', '-q']);
    sh(['config', 'user.email', 't@t']);
    sh(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'A\n');
    sh(['add', '-A']);
    sh(['commit', '-qm', 'init']);
    slots = { '/workspace/project': repo };
    allowlist = [tmp];
    const direct = {
      kind: 'slot' as const,
      class: 'allowlisted-extra' as const,
      containerPath: '/workspace/project',
      mode: 'rw' as const,
    };
    const a = agent();
    await a.handle('prepare', { spec: spec({ mounts: [direct] }) });
    const src1 = cli.containerMounts.get('ncl-spike-s1');
    expect(src1).toEqual(['/workspace/project', '/workspace/project/.git', '/workspace/project/.vscode']);
    // Central switches the slot to propose: the container now points at the wrong source.
    const b = agent();
    expect(await b.handle('prepare', { spec: spec({ mounts: [{ ...direct, propose: true }] }) })).toEqual({
      name: 'ncl-spike-s1',
    }); // recreated
    expect(logs.some((l) => l.includes('is bound to a different source for /workspace/project'))).toBe(true);
    const create = cli.calls.filter((c) => c[0] === 'create').pop()!;
    const vol = create.filter((_, i) => create[i - 1] === '-v').find((v) => v.endsWith(':/workspace/project'))!;
    expect(vol.startsWith(path.join(tmp, 'runner', 'proposals'))).toBe(true);
    // And back again: the same spec adopts rather than churning.
    cli.calls.length = 0;
    const c = agent();
    expect(await c.handle('prepare', { spec: spec({ mounts: [{ ...direct, propose: true }] }) })).toEqual({
      name: 'ncl-spike-s1',
      reused: true,
    });
    expect(cli.calls.some((x) => x[0] === 'rm')).toBe(false);
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('a container that still has a network is recreated: the machine enforces --network none', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const a = agent();
    const sp = spec({ mounts: [] });
    await a.handle('prepare', { spec: sp });
    expect(cli.containerNetwork.get('ncl-spike-s1')).toBe('none'); // fresh containers are network-less
    // A container from a build that let central's spec pick the network.
    cli.containerNetwork.set('ncl-spike-s1', 'bridge');
    const b = agent();
    expect(await b.handle('prepare', { spec: sp })).toEqual({ name: 'ncl-spike-s1' }); // recreated
    expect(logs.some((l) => l.includes('still has a network'))).toBe(true);
    expect(cli.containerNetwork.get('ncl-spike-s1')).toBe('none');
    a.dispose();
    b.dispose();
  });

  it('concurrent prepares of one image build it once', async () => {
    const a = agent();
    const build = pack({ Dockerfile: 'FROM scratch' });
    for (const c of build.chunks) await a.handle('bundle', c);
    const s1 = spec({ build: { bundle: build.hash, args: {} } });
    const s2 = spec({ ...s1, name: 'ncl-spike-s2', key: { ...s1.key, sessionId: 's2' } });
    await Promise.all([a.handle('prepare', { spec: s1 }), a.handle('prepare', { spec: s2 })]);
    expect(cli.calls.filter((c) => c[0] === 'build')).toHaveLength(1);
    expect(cli.calls.filter((c) => c[0] === 'create')).toHaveLength(2);
  });

  it('attaches the relay forwarder inside the container once it is running', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const a = agent();
    const sp = spec({ mounts: [] });
    await a.handle('prepare', { spec: sp });
    await a.handle('start', { name: 'ncl-spike-s1', key: sp.key });
    await new Promise((r) => setTimeout(r, 30)); // attach waits for the runtime to report running
    const exec = cli.calls.find((c) => c[0] === 'exec' && c[1] === '-i' && c[3] === 'bun');
    expect(exec).toBeDefined();
    expect(exec![4]).toBe('-e');
    a.dispose();
  });

  it('serves the container log so a silent-but-running session can be explained centrally', async () => {
    const a = agent();
    cli.images.add('nanoclaw-agent-v2-x:latest');
    await a.handle('prepare', { spec: spec({ mounts: [] }) });
    cli.logLines = ['boot ok', 'waiting for work'];
    expect(await a.handle('logs', { name: 'ncl-spike-s1', tail: 2 })).toEqual({
      lines: ['boot ok', 'waiting for work'],
    });
    await expect(a.handle('logs', { name: 'nope' })).rejects.toThrow(/logs for nope/);
  });

  it('a dropped supervision channel is not death: it re-attaches while the container lives', async () => {
    const a = agent();
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const s = spec({ mounts: [] });
    await a.handle('prepare', { spec: s });
    await a.handle('start', { name: 'ncl-spike-s1', key: s.key });
    sent.length = 0;
    // podman's client connection dies while the container keeps running
    cli.waits[0].resolve(125);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.some((f) => f.kind === 'terminal')).toBe(false);
    expect(cli.calls.filter((c) => c[0] === 'start' && c[1] === '--attach')).toHaveLength(2); // re-attached
    expect(logs.some((l) => l.includes('re-attaching'))).toBe(true);
    // and when it really is gone, terminal is reported
    cli.containers.delete('ncl-spike-s1');
    cli.waits[1].resolve(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.some((f) => f.kind === 'terminal')).toBe(true);
    a.dispose();
  });

  it('a runtime that stops answering holds the session: no terminal, one log line, central told once, backoff until it answers', async () => {
    vi.useFakeTimers();
    try {
      const a = agent();
      cli.images.add('nanoclaw-agent-v2-x:latest');
      const s = spec({ mounts: [] });
      await a.handle('prepare', { spec: s });
      await a.handle('start', { name: 'ncl-spike-s1', key: s.key });
      sent.length = 0;
      logs.length = 0;
      // The laptop slept; podman's machine did not come back.
      cli.runtimeDown = true;
      cli.waits[0].resolve(125);
      await vi.advanceTimersByTimeAsync(10);
      expect(sent.filter((f) => f.type === 'runtime')).toEqual([
        { type: 'runtime', reachable: false, detail: expect.stringContaining('Cannot connect to Podman') },
      ]);
      // Many failed attempts later — far past the old 50-strike cap — still no verdict.
      for (let i = 0; i < 60; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
        const w = cli.waits[cli.waits.length - 1];
        w.resolve(125);
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(sent.some((f) => f.kind === 'terminal')).toBe(false);
      expect(sent.filter((f) => f.type === 'runtime')).toHaveLength(1);
      expect(logs.filter((l) => l.includes('not answering'))).toHaveLength(2); // the runtime, and the session — once each
      // Status tells the truth instead of "absent", which central read as stopped.
      await expect(a.handle('status', { name: 'ncl-spike-s1' })).rejects.toMatchObject({
        failure: { kind: 'runtime-unavailable', retryable: true },
      });
      // A reconnect to central re-reports the down runtime.
      sent.length = 0;
      a.centralReconnected();
      expect(sent).toEqual([
        { type: 'runtime', reachable: false, detail: expect.stringContaining('Cannot connect to Podman') },
      ]);

      // podman machine start: the container did not survive — now, and only now, terminal.
      cli.runtimeDown = false;
      cli.containers.delete('ncl-spike-s1');
      sent.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      cli.waits[cli.waits.length - 1].resolve(125);
      await vi.advanceTimersByTimeAsync(10);
      const order = sent.map((f) => (f.type === 'runtime' ? `runtime:${String(f.reachable)}` : String(f.kind)));
      expect(order.filter((o) => o === 'terminal' || o.startsWith('runtime'))).toEqual(['terminal', 'runtime:true']);
      a.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a container podman reports as 'initialized' just after start still gets its relay", async () => {
    const a = agent();
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const s = spec({ mounts: [] });
    await a.handle('prepare', { spec: s });
    cli.containers.get('ncl-spike-s1')!.state = 'initialized'; // the state podman shows for a moment
    await a.handle('start', { name: 'ncl-spike-s1', key: s.key });
    cli.containers.get('ncl-spike-s1')!.state = 'initialized';
    await new Promise((r) => setTimeout(r, 1200));
    cli.containers.get('ncl-spike-s1')!.state = 'running';
    await new Promise((r) => setTimeout(r, 1500));
    expect(logs.some((l) => l.includes('relay not attached'))).toBe(false);
    expect(cli.calls.some((c) => c[0] === 'exec')).toBe(true); // the forwarder was attached
    a.dispose();
  });

  it('a resume attaches to a running container but never revives one that stopped while unattended', async () => {
    const a = agent();
    cli.images.add('nanoclaw-agent-v2-x:latest');
    const s = spec({ mounts: [] });
    await a.handle('prepare', { spec: s });
    await a.handle('start', { name: 'ncl-spike-s1', key: s.key });
    // Still running and supervised: a resume is a no-op.
    expect(await a.handle('start', { name: 'ncl-spike-s1', key: s.key, resume: true })).toEqual({});
    // A fresh extension host (reload) finds the container exited — a VM crash left the corpse behind.
    a.dispose();
    const b = agent();
    cli.containers.get('ncl-spike-s1')!.state = 'exited';
    cli.calls.length = 0;
    await expect(b.handle('start', { name: 'ncl-spike-s1', key: s.key, resume: true })).rejects.toThrow(
      /no container ncl-spike-s1/,
    );
    expect(cli.calls.some((c) => c[0] === 'start')).toBe(false);
    expect(cli.containers.has('ncl-spike-s1')).toBe(false); // the corpse is cleared for the respawn
    // A runtime that does not answer is a retryable pause, not a verdict.
    cli.runtimeDown = true;
    await expect(b.handle('start', { name: 'ncl-spike-s1', key: s.key, resume: true })).rejects.toMatchObject({
      failure: { kind: 'runtime-unavailable', retryable: true },
    });
    b.dispose();
  });

  it('re-attaching after a reload recovers the proposal clone from disk, without moving it', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
    g(repo, 'init', '-q');
    g(repo, 'config', 'user.email', 't@t');
    g(repo, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'main.bicep'), 'resource x\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-qm', 'one');
    const a = agent();
    const key = { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' };
    const { ensureProposalClone } = await import('./git-changes.js');
    const made = await ensureProposalClone(repo, a.proposalDir(key));
    fs.writeFileSync(path.join(made.dir, 'main.bicep'), 'resource x\n// the agent was here\n'); // an unapplied proposal
    a.dispose();
    // A fresh extension host: nothing in memory, the container still running.
    const b = agent();
    cli.containers.set('ncl-spike-s1', {
      labels: { 'nanoclaw-install': 'spike', 'nanoclaw-group': 'g1', 'nanoclaw-session': 's1' },
      state: 'running',
    });
    expect(b.currentProposal()).toBeNull();
    await b.handle('start', { name: 'ncl-spike-s1', key, resume: true });
    expect(b.currentProposal()).toMatchObject({ repoRoot: repo, dir: made.dir, base: made.base });
    expect(fs.readFileSync(path.join(made.dir, 'main.bicep'), 'utf8')).toContain('the agent was here');
    b.dispose();
  });

  it('a supervision channel that held a while does not count toward giving up (podman drops it every few minutes)', async () => {
    vi.useFakeTimers();
    try {
      const a = agent();
      cli.images.add('nanoclaw-agent-v2-x:latest');
      const s = spec({ mounts: [] });
      await a.handle('prepare', { spec: s });
      await a.handle('start', { name: 'ncl-spike-s1', key: s.key });
      sent.length = 0;
      for (let i = 0; i < 80; i++) {
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        cli.waits[cli.waits.length - 1].resolve(125);
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(sent.some((f) => f.kind === 'terminal')).toBe(false);
      a.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed build carries its output tail, not just the exit code', async () => {
    cli.buildExit = 1;
    const a = agent();
    const build = pack({ Dockerfile: 'FROM scratch' });
    for (const c of build.chunks) await a.handle('bundle', c);
    await expect(a.handle('prepare', { spec: spec({ build: { bundle: build.hash, args: {} } }) })).rejects.toThrow(
      /exited 1: .*Step 1\/2/,
    );
  });

  it('pull: a failed pull is retryable and names the registry problem; no reference at all is refused', async () => {
    cli.pullExit = 1;
    await expect(agent(() => pullPolicy()).handle('prepare', { spec: pinned() })).rejects.toMatchObject({
      failure: { kind: 'image-unavailable', retryable: true },
    });
    cli.pullExit = 0;
    await expect(
      agent(() => pullPolicy()).handle('prepare', { spec: spec({ build: { bundle: 'c'.repeat(64), args: {} } }) }),
    ).rejects.toThrow(/no reference is set/);
  });

  it('build stays the default when no policy is wired', async () => {
    cli.images.add('nanoclaw-agent-v2-x:latest');
    await agent().handle('prepare', { spec: pinned() });
    expect(cli.calls.some((c) => c[0] === 'pull')).toBe(false);
  });
});

describe('central authority over the image', () => {
  const local: ImagePolicy = { source: 'build', ref: 'mirror.local/agent:1', allowUnlabeled: false };
  const base = { v: 1 } as unknown as RemoteSpec;

  it('no stated policy: this machine decides and its own reference wins', () => {
    expect(effectiveImagePolicy(local, { ...base, imageRef: 'central.pin/agent:1' })).toEqual({
      ...local,
      governed: false,
    });
  });
  it("a stated policy overrides the machine, and central's reference wins with it", () => {
    expect(effectiveImagePolicy(local, { ...base, imagePolicy: 'pull', imageRef: 'central.pin/agent:1' })).toEqual({
      source: 'pull',
      ref: 'central.pin/agent:1',
      allowUnlabeled: false,
      governed: true,
    });
    // ...falling back to the machine's reference only when central names none
    expect(effectiveImagePolicy(local, { ...base, imagePolicy: 'pull' }).ref).toBe('mirror.local/agent:1');
    // ...and 'build' forces a local build even on a machine set to pull
    expect(effectiveImagePolicy({ ...local, source: 'pull' }, { ...base, imagePolicy: 'build' })).toMatchObject({
      source: 'build',
      governed: true,
    });
  });
  it('the override is honoured end to end and says so in the log', async () => {
    const CENTRAL = 'central.pin/agent@sha256:' + 'f'.repeat(64);
    cli.imageLabels.set(CENTRAL, 'a'.repeat(64));
    const a = agent(() => ({ source: 'build', ref: '', allowUnlabeled: false }));
    await a.handle('prepare', {
      spec: spec({
        imagePolicy: 'pull',
        imageRef: CENTRAL,
        build: { bundle: 'c'.repeat(64), args: {}, lockSha: 'a'.repeat(64) },
      }),
    });
    expect(cli.calls.find((c) => c[0] === 'pull')).toEqual(['pull', CENTRAL]);
    expect(cli.calls.some((c) => c[0] === 'build')).toBe(false);
    expect(logs.some((l) => l.includes('central requires the agent image to be pulled'))).toBe(true);
  });
});
