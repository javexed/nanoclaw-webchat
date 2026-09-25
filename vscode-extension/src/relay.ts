// The relay's laptop half, made indifferent to a flaky pipe.
//
// The container's proxy traffic reaches central through a forwarder that runs
// INSIDE the container. Nothing listens on the developer's machine and the
// container needs no network of its own: the tunnel through central is the
// only way out.
//
// The forwarder is a persistent DAEMON, not a child of the exec pipe. Podman's
// client connection to its machine drops on its own every few minutes; when
// the pipe was the forwarder's lifeline, every drop killed every tunnel and
// an inference call in flight died with it. Now a drop only pauses bytes:
//
//   agent ⇄ 127.0.0.1:18080 ⇄ daemon ⇄ /tmp/nanoclaw-relay.sock ⇄ attach client ⇄ exec pipe ⇄ extension ⇄ central
//
// Frames in both directions carry sequence numbers and are acknowledged. Each
// side keeps what the other has not acknowledged and replays it on the next
// attach, so the agent's TCP connections (and the TLS inside them) survive a
// drop as a pause rather than a reset. If nothing re-attaches for a grace
// period the daemon closes its tunnels — the agent retries — and waits.
import type { Cli } from './docker.js';
import type { SessionKey } from './remote-spec.js';

/** Inside the container's own network namespace, so it can never collide with anything on the host. */
export const CONTAINER_RELAY_PORT = 18080;
export const CONTAINER_RELAY_URL = `http://127.0.0.1:${CONTAINER_RELAY_PORT}`;
const CONTROL_SOCK = '/tmp/nanoclaw-relay.sock';
/** Exit code of the attach client when no daemon answers: the caller starts one and re-attaches at once. */
export const RELAY_NO_DAEMON_EXIT = 3;
/** Marker every daemon carries in its command line, so a predecessor can be found and evicted. */
const MARK = 'nanoclaw relay tunnels CONNECT only';
/** Bumped whenever the daemon script changes; a running daemon of another version is replaced on attach. */
export const DAEMON_VERSION = 4;
/** Marker the attach client carries (the harness kills it by this to simulate a dropped pipe). */
export const ATTACH_MARK = 'nanoclaw-relay-attach';

export interface RelayDeps {
  send: (frame: Record<string, unknown>) => void;
  log: (line: string) => void;
}

/**
 * Runs in the container under Bun, detached. Speaks CONNECT on loopback for
 * the agent; speaks the reliable line protocol on the control socket for
 * whoever is attached. One client at a time; a new hello replaces the old.
 */
const DAEMON = `
const net = require('net');
const fs = require('fs');
const PORT = ${CONTAINER_RELAY_PORT};
const SOCK = ${JSON.stringify(CONTROL_SOCK)};
const GRACE_MS = 90000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MARK = ${JSON.stringify(MARK)};
const VERSION = ${DAEMON_VERSION};
const LOG = '/tmp/nanoclaw-relay.log';
const logf = (m) => {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) fs.truncateSync(LOG, 0);
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\\n');
  } catch {}
};
process.on('uncaughtException', (e) => logf('uncaught: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => logf('unhandled: ' + (e && e.stack ? e.stack : e)));

// ---- evict a predecessor holding our port (an older build, or a stale copy)
const pids = () => fs.readdirSync('/proc').filter((d) => /^\\d+$/.test(d)).map(Number).filter((p) => p !== process.pid);
const portOwner = () => {
  const hex = ('0000' + PORT.toString(16).toUpperCase()).slice(-4);
  let inode = null;
  try {
    for (const line of fs.readFileSync('/proc/net/tcp', 'utf8').split('\\n').slice(1)) {
      const f = line.trim().split(/\\s+/);
      if (f.length > 9 && f[1] === '0100007F:' + hex && f[3] === '0A') inode = f[9];
    }
  } catch {}
  if (!inode) return null;
  for (const p of pids()) {
    try {
      for (const fd of fs.readdirSync('/proc/' + p + '/fd')) {
        if (fs.readlinkSync('/proc/' + p + '/fd/' + fd) === 'socket:[' + inode + ']') return p;
      }
    } catch {}
  }
  return null;
};
const evict = () => {
  for (const p of pids()) {
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8'); } catch { continue; }
    if (cmd.includes(MARK)) { try { process.kill(p, 'SIGKILL'); } catch {} }
  }
  const owner = portOwner();
  if (owner) { try { process.kill(owner, 'SIGKILL'); } catch {} }
};
evict();
try { fs.unlinkSync(SOCK); } catch {}
logf('daemon start pid=' + process.pid);

// ---- tunnels (agent side)
const streams = new Map(); // id -> socket
const heads = new Map();   // id -> bytes to send once the stream is open
const plainStreams = new Set(); // ids opened by an absolute-form HTTP request
const opened = new Set(); // ids central has opened (a refusal after this is a plain close)
let nextStream = 0;

/**
 * An absolute-form proxy request: "GET http://host:port/path HTTP/1.1".
 * Returns the target and the request rewritten to origin-form, with the
 * proxy-only headers removed, or null when this is not one.
 */
const parseAbsolute = (head) => {
  const lines = head.split('\\r\\n');
  const m = /^([A-Z]+) http:\\/\\/([^/\\s:]+)(?::(\\d+))?(\\S*) (HTTP\\/1\\.[01])$/.exec(lines[0] || '');
  if (!m) return null;
  const [, method, host, portStr, pathRaw, version] = m;
  const rest = lines.slice(1).filter((l) => !/^proxy-connection:/i.test(l));
  const request = [method + ' ' + (pathRaw || '/') + ' ' + version, ...rest].join('\\r\\n') + '\\r\\n\\r\\n';
  return { host, port: Number(portStr || 80), request };
};

// ---- reliable channel to the attached client
let client = null;          // control socket of the attached extension
let outSeq = 0;             // last seq assigned to a daemon→client frame
const outbuf = [];          // [{seq, line, bytes}] not yet acknowledged
let outbufBytes = 0;
let inSeq = 0;              // last client→daemon seq processed
let graceTimer = null;

const pauseAll = () => { for (const s of streams.values()) s.pause(); };
const resumeAll = () => { for (const s of streams.values()) s.resume(); };
const resetTunnels = (why) => {
  for (const s of streams.values()) s.destroy();
  streams.clear(); heads.clear(); plainStreams.clear();
  outbuf.length = 0; outbufBytes = 0;
  if (client) { try { client.write(JSON.stringify({ t: 'reset', why }) + '\\n'); } catch {} }
};
const emit = (o) => {
  const seq = ++outSeq;
  const line = JSON.stringify({ ...o, seq }) + '\\n';
  outbuf.push({ seq, line, bytes: line.length });
  outbufBytes += line.length;
  if (outbufBytes > MAX_BUFFER_BYTES) {
    // Nobody is taking bytes away fast enough to make waiting sane: reset.
    resetTunnels('relay buffer overflow while detached');
    return;
  }
  if (client) client.write(line);
  else pauseAll();
};
const ackFromClient = (seq) => {
  while (outbuf.length && outbuf[0].seq <= seq) outbufBytes -= outbuf.shift().bytes;
  if (client && outbufBytes < MAX_BUFFER_BYTES / 2) resumeAll();
};

const tunnelServer = net
  .createServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\\r\\n\\r\\n');
      if (end === -1) {
        if (buf.length > 16384) sock.destroy();
        return;
      }
      const head = buf.slice(0, end).toString();
      const m = /^CONNECT ([^\\s:]+):(\\d+)/.exec(head);
      // Two proxy shapes reach us: CONNECT for TLS (the model), and an
      // absolute-form request for plain HTTP (central's MCP relay, which is
      // http:// and token-gated). Both become one stream; only CONNECT gets a
      // 200 handshake, since a plain request expects the response itself.
      const plain = m ? null : parseAbsolute(head);
      if (!m && !plain) {
        sock.end('HTTP/1.1 501 Not Implemented\\r\\n\\r\\nnanoclaw relay speaks CONNECT and absolute-form HTTP\\n');
        return;
      }
      sock.removeListener('data', onData);
      const id = 's' + nextStream++;
      streams.set(id, sock);
      if (plain) plainStreams.add(id);
      heads.set(id, plain ? Buffer.concat([Buffer.from(plain.request, 'latin1'), buf.slice(end + 4)]) : buf.slice(end + 4));
      sock.on('data', (d) => emit({ t: 'data', id, b64: d.toString('base64') }));
      sock.on('close', () => { plainStreams.delete(id); if (streams.delete(id)) emit({ t: 'close', id }); });
      sock.on('error', () => {});
      if (!client) sock.pause(); // detached: hold the request until the pipe is back
      emit({ t: 'open', id, host: m ? m[1] : plain.host, port: m ? Number(m[2]) : plain.port });
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  });
let bindTries = 0;
tunnelServer.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE' && bindTries++ < 40) {
    // A just-evicted holder may not have released the port yet.
    evict();
    setTimeout(() => tunnelServer.listen(PORT, '127.0.0.1'), 250);
    return;
  }
  logf('tunnel server error: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
tunnelServer.listen(PORT, '127.0.0.1', () => logf('listening on ' + PORT));

// ---- control socket: the extension's attach client
const handleClientFrame = (f) => {
  if (f.t === 'ack') { ackFromClient(Number(f.seq)); return; }
  if (f.t === 'reset-all') {
    // The extension's link to central was re-established: central closed every
    // stream it had for us, so the agent's connections through them are dead.
    // Reset them now so the agent retries at once instead of hanging on a pool
    // of zombies.
    if (typeof f.seq === 'number') { inSeq = Math.max(inSeq, f.seq); client && client.write(JSON.stringify({ t: 'ack', seq: f.seq }) + '\\n'); }
    logf('reset-all from client (' + streams.size + ' streams)');
    resetTunnels('central link reconnected');
    return;
  }
  if (typeof f.seq === 'number') {
    if (f.seq <= inSeq) { client && client.write(JSON.stringify({ t: 'ack', seq: f.seq }) + '\\n'); return; } // duplicate after a replay
    inSeq = f.seq;
    client && client.write(JSON.stringify({ t: 'ack', seq: f.seq }) + '\\n');
  }
  const sock = streams.get(f.id);
  if (f.t === 'opened') {
    if (!sock) return;
    opened.add(f.id);
    // A tunnel is established for the client; a plain request just goes out.
    if (!plainStreams.has(f.id)) sock.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    const head = heads.get(f.id);
    heads.delete(f.id);
    if (head && head.length) emit({ t: 'data', id: f.id, b64: head.toString('base64') });
  } else if (f.t === 'data') {
    sock && sock.write(Buffer.from(f.b64, 'base64'));
  } else if (f.t === 'close') {
    const wasOpen = opened.has(f.id);
    streams.delete(f.id); heads.delete(f.id); plainStreams.delete(f.id); opened.delete(f.id);
    // Central refused before anything was established (e.g. the network
    // policy): answer like a proxy would, with its reason, so curl / npm /
    // fetch report why instead of "connection reset".
    if (sock && !wasOpen && f.error) {
      const body = String(f.error).slice(0, 300) + '\\n';
      sock.end('HTTP/1.1 403 Forbidden\\r\\nContent-Type: text/plain\\r\\nContent-Length: ' + Buffer.byteLength(body) + '\\r\\nConnection: close\\r\\n\\r\\n' + body);
    } else {
      sock && sock.destroy();
    }
  }
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
          // A client whose own counter is behind what we have processed is a NEW
          // client (the extension host restarted): its frames start over, so
          // must our duplicate detection — or every frame it sends is "old".
          if (Number(f.seq || 0) < inSeq) inSeq = Number(f.seq || 0);
          ackFromClient(Number(f.ack || 0));
          logf('hello ack=' + f.ack + ' clientSeq=' + f.seq + ' → replay ' + outbuf.length + ', inSeq=' + inSeq + ', outSeq=' + outSeq);
          c.write(JSON.stringify({ t: 'ready', v: VERSION, port: PORT, seq: outSeq, inSeq }) + '\\n');
          for (const e of outbuf) c.write(e.line); // replay what the last client never acknowledged
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
      logf('client gone; ' + streams.size + ' streams paused, ' + outbuf.length + ' frames buffered');
      graceTimer = setTimeout(() => { logf('grace expired'); resetTunnels('no attach within grace period'); }, GRACE_MS);
    };
    c.on('close', gone);
    c.on('error', gone);
  })
  .on('error', (e) => { logf('control server error: ' + (e && e.message ? e.message : e)); process.exit(1); })
  .listen(SOCK, () => { try { fs.chmodSync(SOCK, 0o600); } catch {} logf('control socket ready'); });
`;

/**
 * Runs in the container under Bun, attached to the exec pipe. A dumb bridge:
 * stdin lines go to the daemon's control socket, socket lines go to stdout.
 * Exits RELAY_NO_DAEMON_EXIT when no daemon answers, so the caller knows to start one.
 */
const ATTACH = `
// ${ATTACH_MARK}
const net = require('net');
const SOCK = ${JSON.stringify(CONTROL_SOCK)};
const s = net.connect(SOCK);
s.on('error', (e) => { process.stdout.write(JSON.stringify({ t: 'no-daemon', why: e.code || String(e) }) + '\\n'); process.exit(${RELAY_NO_DAEMON_EXIT}); });
s.on('connect', () => { process.stdout.write(JSON.stringify({ t: 'attached' }) + '\\n'); });
s.on('data', (d) => process.stdout.write(d));
s.on('close', () => process.exit(0));
process.stdin.on('data', (d) => s.write(d));
process.stdin.on('end', () => s.end());
process.stdin.on('close', () => s.end());
`;

/** For tests: the scripts must at least parse — an escape slip here is invisible until a real container. */
export const __embeddedScripts = { DAEMON, ATTACH };

/** Kill every daemon in the container (by its command-line marker), sparing the shell running this. */
const KILL_DAEMONS = `me=$$; for p in /proc/[0-9]*; do pid=$(basename $p); [ "$pid" = "$me" ] && continue; if tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q '${MARK}'; then kill -9 $pid; fi; done; true`;

export class SessionRelay {
  #proc: { done: Promise<number | null>; kill: () => void; write: (s: string) => void } | null = null;
  #ready = false;
  /** Non-frame lines the attach client (or podman) printed — the only place an exit explains itself. */
  readonly #noise: string[] = [];
  /** Reliable channel state; survives a dropped pipe. */
  #outSeq = 0;
  readonly #pending = new Map<number, string>(); // seq → line not yet acknowledged by the daemon
  #inSeq = 0; // last daemon seq processed
  #attachedAt = 0;
  #closed = false;
  #cli: Cli | null = null;
  #container = '';
  /** The last reason an attach ended, and how often it has repeated since (logged once, then counted). */
  #lastEnd = '';
  #endRepeats = 0;
  /** Central lost every tunnel; the daemon must be told once it is ready. */
  #needReset = false;

  constructor(
    private readonly key: SessionKey,
    private readonly d: RelayDeps,
  ) {}

  get ready(): boolean {
    return this.#ready;
  }
  /** Frames waiting for the daemon's acknowledgement (replayed on re-attach). */
  get pendingCount(): number {
    return this.#pending.size;
  }
  /** How long the current attach has been up, ms; 0 when detached. */
  get attachedForMs(): number {
    return this.#attachedAt ? Date.now() - this.#attachedAt : 0;
  }

  /** Start the persistent forwarder daemon inside the container. It evicts a stale port holder, never a live daemon's tunnels. */
  async startDaemon(cli: Cli, container: string): Promise<void> {
    await cli.run(['exec', '-d', container, 'bun', '-e', DAEMON], { timeoutMs: 20_000 });
  }

  /**
   * Attach to the daemon over a fresh exec pipe. Resolves with the exit code
   * when the pipe ends (RELAY_NO_DAEMON_EXIT means: start the daemon, then
   * call again); null if already attached.
   */
  attach(cli: Cli, container: string): Promise<number | null> | null {
    if (this.#proc || this.#closed) return null;
    this.#noise.length = 0;
    this.#ready = false;
    const proc = cli.start(['exec', '-i', container, 'bun', '-e', ATTACH], (line) => this.#onLine(line));
    this.#proc = proc;
    this.#cli = cli;
    this.#container = container;
    // First word to the daemon: what we have already seen, so it replays only the rest.
    proc.write(`${JSON.stringify({ t: 'hello', ack: this.#inSeq, seq: this.#outSeq })}\n`);
    return proc.done.then((code) => {
      if (this.#proc === proc) {
        this.#proc = null;
        this.#ready = false;
        this.#attachedAt = 0;
      }
      if (code !== RELAY_NO_DAEMON_EXIT) {
        // While the runtime is away every attach fails the same way; say it
        // once and count, rather than one identical line per retry.
        const why = `relay pipe for ${container} ended (${code ?? 'signal'})${this.#noise.length ? `: ${this.#noise.slice(-4).join(' | ')}` : ''}`;
        if (why === this.#lastEnd) {
          this.#endRepeats += 1;
        } else {
          if (this.#endRepeats > 0) this.d.log(`(previous relay line repeated ${this.#endRepeats} more time(s))`);
          this.#lastEnd = why;
          this.#endRepeats = 0;
          this.d.log(`${why}; ${this.#pending.size} frame(s) held for replay`);
        }
      }
      return code;
    });
  }

  #onLine(line: string): void {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#noise.push(line.slice(0, 200));
      if (this.#noise.length > 8) this.#noise.shift();
      return;
    }
    switch (f.t) {
      case 'attached':
      case 'no-daemon':
        return;
      case 'ready': {
        if (Number(f.v ?? 0) !== DAEMON_VERSION) {
          // A daemon from another build. Attaching never replaces one, so
          // evict it here; the pipe ends, the loop finds no daemon, starts ours.
          this.d.log(
            `relay daemon is version ${String(f.v ?? 'unknown')}, this runner needs ${DAEMON_VERSION}; replacing it`,
          );
          void this.#cli
            ?.run(['exec', this.#container, 'sh', '-c', KILL_DAEMONS], { timeoutMs: 15_000 })
            .catch(() => {});
          return;
        }
        this.#ready = true;
        this.#attachedAt = Date.now();
        // A daemon whose counter is behind ours is a NEW daemon (the old one was
        // evicted or died): its tunnels are gone with it, so our replay queue
        // and high-water mark refer to nothing. Start clean rather than drop
        // every frame it sends as a "duplicate".
        if (Number(f.seq ?? 0) < this.#inSeq) {
          this.#inSeq = Number(f.seq ?? 0);
          this.#pending.clear();
          this.d.log('relay daemon was replaced; tunnels reset');
        }
        // Replay everything the daemon has not acknowledged, in order.
        const daemonSaw = Number(f.inSeq ?? 0);
        const replayed = [...this.#pending.entries()].sort((a, b) => a[0] - b[0]);
        for (const [seq, l] of replayed) {
          if (seq <= daemonSaw) this.#pending.delete(seq);
          else this.#proc?.write(l);
        }
        this.d.log(
          `relay attached inside the container on ${CONTAINER_RELAY_URL}${this.#pending.size ? ` (replayed ${this.#pending.size})` : ''}`,
        );
        this.#sendResetIfReady();
        return;
      }
      case 'ack':
        this.#pending.delete(Number(f.seq));
        return;
      case 'reset':
        this.#pending.clear();
        this.#inSeq = 0;
        this.d.log(`relay daemon reset its tunnels: ${String(f.why ?? '')}`);
        return;
    }
    // Sequenced daemon → central frames.
    const seq = Number(f.seq);
    if (Number.isFinite(seq)) {
      if (seq <= this.#inSeq) {
        this.#proc?.write(`${JSON.stringify({ t: 'ack', seq })}\n`); // a replayed duplicate
        return;
      }
      this.#inSeq = seq;
    }
    const id = String(f.id ?? '');
    switch (f.t) {
      case 'open':
        this.d.send({
          type: 'relay.open',
          streamId: id,
          key: this.key,
          host: String(f.host ?? ''),
          port: Number(f.port),
        });
        break;
      case 'data':
        this.d.send({ type: 'relay.data', streamId: id, b64: String(f.b64 ?? '') });
        break;
      case 'close':
        this.d.send({ type: 'relay.close', streamId: id });
        break;
      default:
        return;
    }
    if (Number.isFinite(seq)) this.#proc?.write(`${JSON.stringify({ t: 'ack', seq })}\n`);
  }

  /**
   * Our link to central was (re)established. Central closes every stream it
   * held for this machine when a link drops, so the agent's connections
   * through the daemon are dead: tell the daemon to reset them, and forget
   * the frames we were holding for them.
   */
  linkReconnected(): void {
    this.#pending.clear();
    this.#needReset = true;
    this.#sendResetIfReady();
  }
  #sendResetIfReady(): void {
    if (!this.#needReset || !this.#ready) return;
    this.#needReset = false;
    const seq = ++this.#outSeq;
    this.#proc?.write(`${JSON.stringify({ t: 'reset-all', seq })}\n`);
    this.d.log('relay: central link reconnected — resetting the container’s tunnels so the agent retries');
  }

  /** Frames central sends back. Returns true when the frame was ours. */
  handleFrame(frame: Record<string, unknown>): boolean {
    const id = String(frame.streamId ?? '');
    let o: Record<string, unknown>;
    switch (frame.type) {
      case 'relay.opened':
        o = { t: 'opened', id };
        break;
      case 'relay.data':
        o = { t: 'data', id, b64: String(frame.b64 ?? '') };
        break;
      case 'relay.close':
        if (frame.error) this.d.log(`relay stream ${id} closed by central: ${String(frame.error)}`);
        o = { t: 'close', id, ...(frame.error ? { error: String(frame.error).slice(0, 300) } : {}) };
        break;
      default:
        return false;
    }
    const seq = ++this.#outSeq;
    const line = `${JSON.stringify({ ...o, seq })}\n`;
    this.#pending.set(seq, line);
    if (this.#ready) this.#proc?.write(line);
    return true;
  }

  /** Ends this relay for good: the pipe is killed and no further attach is accepted (a disposed agent must not fight its successor). */
  close(): void {
    this.#closed = true;
    this.#proc?.kill();
    this.#proc = null;
    this.#ready = false;
    this.#attachedAt = 0;
  }
}
