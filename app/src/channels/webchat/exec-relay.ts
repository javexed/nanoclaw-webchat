/**
 * Exec relay: central's own agents reach out over a pipe central opens, not a
 * network.
 *
 * A relayed container runs with `--network none`, and its gateway endpoint
 * name (host.docker.internal) points at 127.0.0.1. A small forwarder daemon
 * inside the container listens on loopback on the ports the agent dials — the
 * credential gateway's proxy port, central's MCP relay, host-local models —
 * and carries every connection, byte for byte, over a `docker exec` pipe that
 * central holds:
 *
 *   agent ⇄ 127.0.0.1:<port> ⇄ daemon ⇄ /tmp control socket ⇄ attach client ⇄ exec pipe ⇄ central
 *
 * Central then serves each stream exactly as the egress filter serves a TCP
 * connection from the lockdown network (the route the caller gives), except
 * that it knows which container is calling from the pipe itself rather than
 * from a source address. No host listener, so a host firewall has nothing to
 * block, and no address map to keep fresh.
 *
 * The daemon and the reliable line protocol (sequence numbers, acks, replay
 * across a re-attach, a grace period before tunnels reset) came from the VS
 * Code runner's container relay, since retired; this one forwards raw bytes on
 * several ports, and runs as root so the agent can neither stop it nor reach
 * its control socket.
 */
import { execFile, spawn } from 'child_process';
import { duplexPair, type Duplex } from 'stream';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';

/** The control socket, root-owned and 0600 inside the container. */
const CONTROL_SOCK = '/tmp/nanoclaw-exec-relay.sock';
/** Exit code of the attach client when no daemon answers: start one, then attach again. */
export const NO_DAEMON_EXIT = 3;
const MARK = 'nanoclaw exec relay forwards loopback ports';
export const EXEC_RELAY_VERSION = 2;
/** A registered container that has not started within this long is given up on. */
const START_WINDOW_MS = 5 * 60_000;
const TICK_MS = 1_000;

/**
 * Bounds on what central holds for one container's pipe: frames sent but not
 * yet acknowledged by the daemon, which are kept for replay across a
 * re-attach. Above the high-water mark every stream feeding the pipe is
 * paused (so backpressure reaches whoever serves the port), and they resume
 * once acks bring it below the low-water mark. The hard cap mirrors the
 * daemon's own: past it the tunnels are reset rather than the queue grown.
 */
export interface RelayLimits {
  highWaterBytes: number;
  lowWaterBytes: number;
  maxBufferBytes: number;
}
export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  highWaterBytes: 8 * 1024 * 1024,
  lowWaterBytes: 2 * 1024 * 1024,
  maxBufferBytes: 64 * 1024 * 1024,
};

/** The in-container daemon for these ports. Runs under Bun, detached, as root. */
export function daemonScript(ports: readonly number[]): string {
  return `
const net = require('net');
const fs = require('fs');
const PORTS = ${JSON.stringify([...ports])};
const SOCK = ${JSON.stringify(CONTROL_SOCK)};
const GRACE_MS = 90000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MARK = ${JSON.stringify(MARK)};
const VERSION = ${EXEC_RELAY_VERSION};
const LOG = '/tmp/nanoclaw-exec-relay.log';
const logf = (m) => {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) fs.truncateSync(LOG, 0);
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\\n');
  } catch {}
};
process.on('uncaughtException', (e) => logf('uncaught: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => logf('unhandled: ' + (e && e.stack ? e.stack : e)));

// One daemon per container: a predecessor (an older build, a stale copy) goes.
for (const d of fs.readdirSync('/proc')) {
  if (!/^\\d+$/.test(d) || Number(d) === process.pid) continue;
  let cmd = '';
  try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8'); } catch { continue; }
  if (cmd.includes(MARK)) { try { process.kill(Number(d), 'SIGKILL'); } catch {} }
}
try { fs.unlinkSync(SOCK); } catch {}
logf('daemon start pid=' + process.pid + ' ports=' + PORTS.join(','));

const streams = new Map();
let nextStream = 0;
let client = null;
let outSeq = 0;
const outbuf = [];
let outbufBytes = 0;
let inSeq = 0;
let graceTimer = null;

const pauseAll = () => { for (const s of streams.values()) s.pause(); };
const resumeAll = () => { for (const s of streams.values()) s.resume(); };
const resetTunnels = (why) => {
  for (const s of streams.values()) s.destroy();
  streams.clear();
  outbuf.length = 0; outbufBytes = 0;
  if (client) { try { client.write(JSON.stringify({ t: 'reset', why }) + '\\n'); } catch {} }
};
const emit = (o) => {
  const seq = ++outSeq;
  const line = JSON.stringify({ ...o, seq }) + '\\n';
  outbuf.push({ seq, line, bytes: line.length });
  outbufBytes += line.length;
  if (outbufBytes > MAX_BUFFER_BYTES) { resetTunnels('relay buffer overflow while detached'); return; }
  if (client) client.write(line);
  else pauseAll();
};
const ackFromClient = (seq) => {
  while (outbuf.length && outbuf[0].seq <= seq) outbufBytes -= outbuf.shift().bytes;
  if (client && outbufBytes < MAX_BUFFER_BYTES / 2) resumeAll();
};

const onConnection = (port) => (sock) => {
  const id = 's' + nextStream++;
  streams.set(id, sock);
  sock.on('data', (d) => emit({ t: 'data', id, b64: d.toString('base64') }));
  sock.on('close', () => { if (streams.delete(id)) emit({ t: 'close', id }); });
  sock.on('error', () => {});
  if (!client) sock.pause();
  logf('open ' + id + ' port=' + port + (client ? '' : ' (detached, held)'));
  emit({ t: 'open', id, port });
};
// Both loopbacks: Bun resolves the endpoint name to ::1 first and does not
// fall back, so an IPv4-only listener left the agent's connection hanging.
// IPv6 may be off in the container; only the IPv4 listener is required.
for (const port of PORTS) {
  for (const host of ['127.0.0.1', '::1']) {
    const server = net.createServer(onConnection(port));
    let tries = 0;
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && tries++ < 40) { setTimeout(() => server.listen(port, host), 250); return; }
      logf('listen ' + host + ' ' + port + ' failed: ' + (e && e.message ? e.message : e));
      if (host === '127.0.0.1') process.exit(1);
    });
    server.listen(port, host, () => logf('listening on ' + host + ' ' + port));
  }
}

const handleClientFrame = (f) => {
  if (f.t === 'ack') { ackFromClient(Number(f.seq)); return; }
  if (typeof f.seq === 'number') {
    if (f.seq <= inSeq) { client && client.write(JSON.stringify({ t: 'ack', seq: f.seq }) + '\\n'); return; }
    inSeq = f.seq;
    client && client.write(JSON.stringify({ t: 'ack', seq: f.seq }) + '\\n');
  }
  const sock = streams.get(f.id);
  if (f.t === 'data') sock && sock.write(Buffer.from(f.b64, 'base64'));
  else if (f.t === 'close') { streams.delete(f.id); sock && sock.destroy(); }
};

net
  .createServer((c) => {
    let acc = '';
    let hello = false;
    c.on('data', (chunk) => {
      acc += chunk.toString();
      let i;
      while ((i = acc.indexOf('\\n')) !== -1) {
        const line = acc.slice(0, i);
        acc = acc.slice(i + 1);
        if (!line.trim()) continue;
        let f;
        try { f = JSON.parse(line); } catch { continue; }
        if (!hello) {
          if (f.t !== 'hello') { c.destroy(); return; }
          hello = true;
          if (client && client !== c) { try { client.destroy(); } catch {} }
          client = c;
          if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
          if (Number(f.seq || 0) < inSeq) inSeq = Number(f.seq || 0);
          ackFromClient(Number(f.ack || 0));
          c.write(JSON.stringify({ t: 'ready', v: VERSION, seq: outSeq, inSeq }) + '\\n');
          for (const e of outbuf) c.write(e.line);
          resumeAll();
          continue;
        }
        handleClientFrame(f);
      }
    });
    const gone = () => {
      if (client !== c) return;
      client = null;
      pauseAll();
      graceTimer = setTimeout(() => resetTunnels('no attach within grace period'), GRACE_MS);
    };
    c.on('close', gone);
    c.on('error', gone);
  })
  .on('error', (e) => { logf('control socket failed: ' + (e && e.message ? e.message : e)); process.exit(1); })
  .listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); } catch {} logf('control socket ready'); });
`;
}

/** Bridges the exec pipe to the daemon's control socket; exits NO_DAEMON_EXIT when there is none. */
export const ATTACH_SCRIPT = `
const net = require('net');
const s = net.connect(${JSON.stringify(CONTROL_SOCK)});
s.on('error', (e) => { process.stdout.write(JSON.stringify({ t: 'no-daemon', why: e.code || String(e) }) + '\\n'); process.exit(${NO_DAEMON_EXIT}); });
s.on('connect', () => process.stdout.write(JSON.stringify({ t: 'attached' }) + '\\n'));
s.on('data', (d) => process.stdout.write(d));
s.on('close', () => process.exit(0));
process.stdin.on('data', (d) => s.write(d));
process.stdin.on('end', () => s.end());
`;

/** Hands one stream (the container's end of an agent connection) to whoever serves its port. */
export type RelayRoute = (port: number, stream: Duplex) => void;

export interface RelayedContainer {
  /** Ports the daemon listens on, on the container's loopback. */
  ports: number[];
  route: RelayRoute;
}

interface Pipe {
  /** False when the pipe is backed up: hold the sources until it drains. */
  write: (line: string) => boolean | void;
  /** Called each time a backed-up pipe drains. */
  onDrain?: (cb: () => void) => void;
  kill: () => void;
  done: Promise<number | null>;
}

/** What a relay needs from the container runtime; a fake in tests. */
export interface RelayRuntime {
  startDaemon(container: string, script: string): Promise<void>;
  attach(container: string, onLine: (line: string) => void): Pipe;
}

export const dockerRelayRuntime: RelayRuntime = {
  startDaemon: (container, script) =>
    new Promise((resolve, reject) =>
      execFile(
        CONTAINER_RUNTIME_BIN,
        ['exec', '-d', '-u', '0', container, 'bun', '-e', script],
        { timeout: 20_000 },
        (err) => (err ? reject(err) : resolve()),
      ),
    ),
  attach(container, onLine) {
    const child = spawn(CONTAINER_RUNTIME_BIN, ['exec', '-i', '-u', '0', container, 'bun', '-e', ATTACH_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let acc = '';
    const lines = (chunk: Buffer): void => {
      acc += chunk.toString('utf8');
      let i: number;
      while ((i = acc.indexOf('\n')) !== -1) {
        onLine(acc.slice(0, i));
        acc = acc.slice(i + 1);
      }
    };
    child.stdout.on('data', lines);
    child.stderr.on('data', (d: Buffer) => onLine(`stderr: ${d.toString('utf8').trim()}`));
    child.stdin.on('error', () => {});
    return {
      write: (line) => child.stdin.write(line),
      onDrain: (cb) => void child.stdin.on('drain', cb),
      kill: () => child.kill('SIGKILL'),
      done: new Promise((resolve) => child.on('close', (code) => resolve(code))),
    };
  },
};

/**
 * One container's relay: keeps the daemon running and a pipe attached, and
 * turns its frames into streams handed to the route.
 */
export class ContainerRelay {
  #pipe: Pipe | null = null;
  #ready = false;
  #closed = false;
  #outSeq = 0;
  readonly #pending = new Map<number, string>();
  #pendingBytes = 0;
  /** The current pipe reported itself backed up and has not drained yet. */
  #pipeBlocked = false;
  /** Whether the streams feeding the pipe are paused. */
  #paused = false;
  #inSeq = 0;
  readonly #streams = new Map<string, Duplex>();
  /** Each stream's other end, the one handed to the route. */
  readonly #peers = new WeakMap<Duplex, Duplex>();

  constructor(
    readonly container: string,
    private readonly c: RelayedContainer,
    private readonly rt: RelayRuntime = dockerRelayRuntime,
    private readonly limits: RelayLimits = DEFAULT_RELAY_LIMITS,
  ) {}

  get ready(): boolean {
    return this.#ready;
  }
  get streamCount(): number {
    return this.#streams.size;
  }
  /** Bytes sent but not yet acknowledged, held for replay. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }
  get paused(): boolean {
    return this.#paused;
  }

  /** Attach until closed: start the daemon when there is none, re-attach when the pipe ends. */
  async run(): Promise<void> {
    let backoff = 250;
    while (!this.#closed) {
      const pipe = this.rt.attach(this.container, (l) => this.#onLine(l));
      this.#pipe = pipe;
      this.#pipeBlocked = false;
      pipe.onDrain?.(() => {
        if (this.#pipe !== pipe || !this.#pipeBlocked) return;
        this.#pipeBlocked = false;
        this.#flow();
      });
      this.#write(`${JSON.stringify({ t: 'hello', ack: this.#inSeq, seq: this.#outSeq })}\n`);
      const code = await pipe.done;
      if (this.#pipe === pipe) {
        this.#pipe = null;
        this.#ready = false;
        this.#pipeBlocked = false;
        this.#flow();
      }
      if (this.#closed) return;
      if (code === NO_DAEMON_EXIT) {
        try {
          await this.rt.startDaemon(this.container, daemonScript(this.c.ports));
          backoff = 250;
          continue;
        } catch (err) {
          log.warn('Exec relay: could not start the forwarder', { container: this.container, err: String(err) });
        }
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 10_000);
    }
  }

  #write(line: string): void {
    if (this.#pipe?.write(line) === false) this.#pipeBlocked = true;
  }

  #send(o: Record<string, unknown>): void {
    const seq = ++this.#outSeq;
    const line = `${JSON.stringify({ ...o, seq })}\n`;
    this.#pending.set(seq, line);
    this.#pendingBytes += line.length;
    if (this.#ready) this.#write(line);
    this.#flow();
  }

  #acked(seq: number): void {
    const line = this.#pending.get(seq);
    if (line === undefined) return;
    this.#pending.delete(seq);
    this.#pendingBytes -= line.length;
  }

  #clearPending(): void {
    this.#pending.clear();
    this.#pendingBytes = 0;
  }

  /**
   * Pause or resume the streams feeding the pipe: held while detached, while
   * the pipe is backed up, or while too much is unacknowledged; past the hard
   * cap the tunnels are reset instead.
   */
  #flow(): void {
    if (this.#pendingBytes > this.limits.maxBufferBytes) {
      this.#overflow();
      return;
    }
    const hold = !this.#ready || this.#pipeBlocked;
    if (!this.#paused && (hold || this.#pendingBytes > this.limits.highWaterBytes)) {
      this.#paused = true;
      for (const s of this.#streams.values()) s.pause();
    } else if (this.#paused && !hold && this.#pendingBytes <= this.limits.lowWaterBytes) {
      this.#paused = false;
      for (const s of this.#streams.values()) s.resume();
    }
  }

  /** As the daemon does on overflow: drop the queue and close every tunnel. */
  #overflow(): void {
    log.warn('Exec relay: replay buffer overflow, resetting tunnels', {
      container: this.container,
      pendingBytes: this.#pendingBytes,
      streams: this.#streams.size,
    });
    this.#clearPending();
    const ids = [...this.#streams.keys()];
    this.#dropStreams();
    this.#paused = false;
    for (const id of ids) this.#send({ t: 'close', id });
  }

  #onLine(line: string): void {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (f.t) {
      case 'attached':
      case 'no-daemon':
        return;
      case 'ready': {
        this.#ready = true;
        // A daemon whose counter is behind ours is a new one: its tunnels died
        // with the old one, so our replay queue refers to nothing.
        if (Number(f.seq ?? 0) < this.#inSeq) {
          this.#inSeq = Number(f.seq ?? 0);
          this.#clearPending();
          this.#dropStreams();
        }
        const saw = Number(f.inSeq ?? 0);
        for (const [seq, l] of [...this.#pending.entries()].sort((a, b) => a[0] - b[0])) {
          if (seq <= saw) this.#acked(seq);
          else this.#write(l);
        }
        this.#flow();
        return;
      }
      case 'ack':
        this.#acked(Number(f.seq));
        this.#flow();
        return;
      case 'reset':
        this.#clearPending();
        this.#inSeq = 0;
        this.#dropStreams();
        this.#flow();
        return;
    }
    const seq = Number(f.seq);
    if (Number.isFinite(seq)) {
      if (seq <= this.#inSeq) {
        this.#write(`${JSON.stringify({ t: 'ack', seq })}\n`);
        return;
      }
      this.#inSeq = seq;
    }
    const id = String(f.id ?? '');
    if (f.t === 'open') this.#open(id, Number(f.port));
    else if (f.t === 'data') this.#streams.get(id)?.write(Buffer.from(String(f.b64 ?? ''), 'base64'));
    else if (f.t === 'close') {
      const s = this.#streams.get(id);
      this.#streams.delete(id);
      s?.end();
    } else return;
    if (Number.isFinite(seq)) this.#write(`${JSON.stringify({ t: 'ack', seq })}\n`);
  }

  #open(id: string, port: number): void {
    // A port the daemon was not told about: the agent's connection is closed at once.
    if (!this.c.ports.includes(port)) return void this.#send({ t: 'close', id });
    const [ours, theirs] = duplexPair();
    this.#streams.set(id, ours);
    this.#peers.set(ours, theirs);
    ours.on('data', (d: Buffer) => this.#send({ t: 'data', id, b64: d.toString('base64') }));
    if (this.#paused) ours.pause();
    const closed = (): void => {
      if (this.#streams.get(id) === ours) {
        this.#streams.delete(id);
        this.#send({ t: 'close', id });
      }
    };
    ours.on('end', closed);
    ours.on('close', closed);
    ours.on('error', () => {});
    // One end destroyed does not tell the other: whoever serves the port may
    // just destroy its end (a refusal, an upstream error), and the agent must
    // see its connection close rather than hang.
    theirs.on('close', () => ours.destroy());
    theirs.on('error', () => {});
    try {
      this.c.route(port, theirs);
    } catch (err) {
      log.warn('Exec relay: route failed', { container: this.container, port, err: String(err) });
      theirs.destroy();
    }
  }

  #dropStreams(): void {
    // Both ends: destroying ours does not tell the route's end, which would
    // otherwise hold whatever it serves the port with open.
    for (const s of this.#streams.values()) {
      s.destroy();
      this.#peers.get(s)?.destroy();
    }
    this.#streams.clear();
  }

  close(): void {
    this.#closed = true;
    this.#pipe?.kill();
    this.#pipe = null;
    this.#ready = false;
    this.#dropStreams();
    this.#clearPending();
  }
}

// ── the containers central relays ──────────────────────────────────────────────

const registered = new Map<string, RelayedContainer & { since: number; seenRunning: boolean }>();
const relays = new Map<string, ContainerRelay>();
let ticker: NodeJS.Timeout | null = null;

function containerState(name: string): Promise<'running' | 'gone' | 'other'> {
  return new Promise((resolve) =>
    execFile(
      CONTAINER_RUNTIME_BIN,
      ['inspect', '--format', '{{.State.Running}}', name],
      { timeout: 10_000 },
      (err, out) =>
        resolve(
          err
            ? /no such (object|container)/i.test(String(err))
              ? 'gone'
              : 'other'
            : String(out).trim() === 'true'
              ? 'running'
              : 'other',
        ),
    ),
  );
}

/** The state probe; tests swap in a fake runtime. */
let probeState: (name: string) => Promise<'running' | 'gone' | 'other'> = containerState;
/**
 * Containers whose probe is still out. A probe can take up to its 10 s
 * timeout while the ticker fires every second: a container with a probe in
 * flight is skipped rather than probed again, so slow probes never pile up,
 * and each container is probed on its own so one slow engine call does not
 * hold back the rest.
 */
const probing = new Set<string>();

async function checkContainer(name: string, reg: RelayedContainer & { since: number; seenRunning: boolean }) {
  const state = await probeState(name);
  // Re-registered (a new spawn under the same name) while the probe was out:
  // this answer is about the old one.
  if (registered.get(name) !== reg) return;
  if (state === 'running') {
    reg.seenRunning = true;
    if (!relays.has(name)) {
      const relay = new ContainerRelay(name, reg);
      relays.set(name, relay);
      log.info('Exec relay: attaching', { container: name, ports: reg.ports });
      void relay.run().catch((err: unknown) => log.warn('Exec relay: stopped', { container: name, err: String(err) }));
    }
  } else if (state === 'gone' && (reg.seenRunning || Date.now() - reg.since > START_WINDOW_MS)) {
    relays.get(name)?.close();
    relays.delete(name);
    registered.delete(name);
  }
}

function tick(): void {
  for (const [name, reg] of registered) {
    if (probing.has(name)) continue;
    probing.add(name);
    void checkContainer(name, reg)
      .catch(() => {})
      .finally(() => probing.delete(name));
  }
  if (registered.size === 0 && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/**
 * Relay this container once it runs. Called at spawn, before the container
 * exists; the container is attached when it starts and forgotten when it is
 * gone.
 */
export function registerRelayedContainer(name: string, c: RelayedContainer): void {
  const prev = registered.get(name);
  registered.set(name, { ...c, since: Date.now(), seenRunning: prev?.seenRunning ?? false });
  // A new spawn under the same name replaces any relay from before.
  relays.get(name)?.close();
  relays.delete(name);
  ticker ??= setInterval(tick, TICK_MS);
  ticker.unref?.();
}

/** For status and tests: whether this container's pipe is attached. */
export function relayReady(name: string): boolean {
  return relays.get(name)?.ready ?? false;
}

export function __resetExecRelayForTest(
  probe: (name: string) => Promise<'running' | 'gone' | 'other'> = containerState,
): void {
  for (const r of relays.values()) r.close();
  relays.clear();
  registered.clear();
  probing.clear();
  probeState = probe;
  if (ticker) clearInterval(ticker);
  ticker = null;
}
