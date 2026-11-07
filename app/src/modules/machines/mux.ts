/**
 * The machine link's wire format: one mutual-TLS socket
 * between central and a worker, carrying JSON messages and many byte streams
 * at once. Built-ins only, because the worker runs this same file on the
 * machine's plain Node (18 or later), with nothing installed beside it.
 *
 * A frame is 9 bytes of header — type (1), stream id (4), length (4) — then
 * the payload. Stream 0 carries JSON messages (requests, replies, events,
 * pings); other ids are byte streams the central side opens (a TCP tunnel to
 * a workload's address) with OPEN, then DATA, END or RST.
 */
import { EventEmitter } from 'events';
import { Duplex } from 'stream';

const MSG = 1;
const OPEN = 2;
const DATA = 3;
const END = 4;
const RST = 5;
/** Flow control: the receiver grants the sender this many more bytes of a stream. */
const WINDOW = 6;

const HEADER = 9;
/** Bigger payloads are split into frames of this size. */
const CHUNK = 64 * 1024;
/** A single JSON message may not exceed this (requests carry small files at most). */
export const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_FRAME = MAX_MESSAGE;
/**
 * Each stream may have this many bytes in flight (sent, not yet read by the
 * receiving side's consumer); the sender waits for a grant past it. Bounds the
 * memory a fast stream with a slow reader can take, on both ends.
 */
export const STREAM_WINDOW = 1024 * 1024;
const PING_MS = 30_000;
const DEAD_MS = 95_000;

export interface Socketish extends EventEmitter {
  write(chunk: Buffer, cb?: (err?: Error | null) => void): boolean;
  destroy(err?: Error): void;
  destroyed?: boolean;
}

export type Message = Record<string, unknown> & { t: string };
export type Handler = (msg: Message) => Promise<unknown> | unknown;
export type StreamHandler = (meta: Record<string, unknown>, stream: Duplex) => void;

function frame(type: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(HEADER);
  h.writeUInt8(type, 0);
  h.writeUInt32BE(id, 1);
  h.writeUInt32BE(payload.length, 5);
  return Buffer.concat([h, payload]);
}

/** One end of a link. `opener` decides stream id parity: central opens even ids, a worker odd ones. */
export class Mux extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private nextReq = 1;
  private nextStream: number;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly streams = new Map<number, Duplex>();
  private readonly flow = new Map<
    number,
    {
      credit: number;
      queue: Array<{ buf: Buffer; cb: (err?: Error | null) => void }>;
      ungranted: number;
      inflight: number;
    }
  >();
  private readonly handlers = new Map<string, Handler>();
  private streamHandler: StreamHandler | null = null;
  private lastSeen = Date.now();
  private readonly pinger: NodeJS.Timeout;
  closed = false;

  constructor(
    private readonly socket: Socketish,
    side: 'central' | 'worker',
  ) {
    super();
    this.nextStream = side === 'central' ? 2 : 1;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.close(new Error('link closed')));
    socket.on('error', (err: Error) => this.close(err));
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_MS) return this.close(new Error('link silent'));
      this.send({ t: 'ping' });
    }, PING_MS);
    this.pinger.unref?.();
  }

  /** Answer requests of this op. The handler's value is the reply; a throw is an error reply. */
  handle(op: string, fn: Handler): void {
    this.handlers.set(op, fn);
  }

  /** Accept streams the other side opens. */
  onStream(fn: StreamHandler): void {
    this.streamHandler = fn;
  }

  send(msg: Message): void {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    if (body.length > MAX_MESSAGE) throw new Error('message too large');
    this.socket.write(frame(MSG, 0, body));
  }

  /** A request; resolves with the other side's reply, rejects on its error or the timeout. */
  request(op: string, payload: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('link closed'));
    const id = this.nextReq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op}: no answer in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...payload, t: 'req', id, op });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Open a byte stream to the other side, which decides what it is from `meta`. */
  open(meta: Record<string, unknown>): Duplex {
    const id = this.nextStream;
    this.nextStream += 2;
    const s = this.stream(id);
    if (this.closed) process.nextTick(() => s.destroy(new Error('link closed')));
    else this.socket.write(frame(OPEN, id, Buffer.from(JSON.stringify(meta), 'utf8')));
    return s;
  }

  close(err: Error = new Error('link closed')): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const s of this.streams.values()) s.destroy(err);
    this.streams.clear();
    this.flow.clear();
    if (!this.socket.destroyed) this.socket.destroy();
    this.emit('close', err);
  }

  private stream(id: number): Duplex {
    let ended = false;
    const f = {
      credit: STREAM_WINDOW,
      queue: [] as Array<{ buf: Buffer; cb: (err?: Error | null) => void }>,
      ungranted: 0,
      inflight: 0,
    };
    this.flow.set(id, f);
    const s = new Duplex({
      // The consumer wants more: grant the sender what it has read since the last grant.
      read: () => {
        if (f.ungranted > 0 && !this.closed && this.streams.has(id)) {
          const g = Buffer.alloc(4);
          g.writeUInt32BE(f.ungranted, 0);
          f.inflight -= f.ungranted;
          f.ungranted = 0;
          this.socket.write(frame(WINDOW, id, g));
        }
      },
      write: (chunk: Buffer, _enc, cb) => {
        if (this.closed) return cb(new Error('link closed'));
        f.queue.push({ buf: chunk, cb });
        this.pump(id);
      },
      final: (cb) => {
        if (!this.closed) this.socket.write(frame(END, id));
        cb();
      },
      destroy: (err, cb) => {
        if (!ended && !this.closed && this.streams.has(id))
          this.socket.write(
            frame(RST, id, Buffer.from(JSON.stringify({ error: err ? String(err.message) : 'closed' }))),
          );
        this.streams.delete(id);
        for (const q of f.queue) q.cb(err ?? new Error('closed'));
        f.queue.length = 0;
        this.flow.delete(id);
        cb(err);
      },
    });
    s.on('end', () => {
      ended = true;
      if (s.writableFinished) this.streams.delete(id);
    });
    // A link stream's failure (the link closing, a reset) must never crash the process:
    // consumers add their own listeners; this one only keeps the error from being unhandled.
    s.on('error', () => undefined);
    // What Node's HTTP client calls on its connection: a stream over the link has nothing to set.
    Object.assign(s, {
      setTimeout: () => s,
      setNoDelay: () => s,
      setKeepAlive: () => s,
      ref: () => s,
      unref: () => s,
    });
    this.streams.set(id, s);
    return s;
  }

  /** Send what the stream's credit allows; a write completes once all of it is sent. */
  private pump(id: number): void {
    const f = this.flow.get(id);
    if (!f) return;
    while (f.queue.length && f.credit > 0 && !this.closed) {
      const q = f.queue[0];
      const n = Math.min(q.buf.length, f.credit, CHUNK);
      this.socket.write(frame(DATA, id, q.buf.subarray(0, n)));
      f.credit -= n;
      q.buf = q.buf.subarray(n);
      if (!q.buf.length) {
        f.queue.shift();
        q.cb();
      }
    }
  }

  private onData(chunk: Buffer): void {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= HEADER) {
      const type = this.buf.readUInt8(0);
      const id = this.buf.readUInt32BE(1);
      const len = this.buf.readUInt32BE(5);
      if (len > MAX_FRAME) return this.close(new Error('frame too large'));
      if (this.buf.length < HEADER + len) return;
      const payload = this.buf.subarray(HEADER, HEADER + len);
      this.buf = this.buf.subarray(HEADER + len);
      try {
        this.onFrame(type, id, payload);
      } catch (err) {
        return this.close(err as Error);
      }
    }
  }

  private onFrame(type: number, id: number, payload: Buffer): void {
    if (type === MSG) return void this.onMessage(JSON.parse(payload.toString('utf8')) as Message);
    if (type === OPEN) {
      const meta = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
      const s = this.stream(id);
      if (!this.streamHandler) return void s.destroy(new Error('streams not accepted'));
      this.streamHandler(meta, s);
      return;
    }
    if (type === WINDOW) {
      const f = this.flow.get(id);
      if (f && payload.length === 4) {
        f.credit += payload.readUInt32BE(0);
        this.pump(id);
      }
      return;
    }
    const s = this.streams.get(id);
    if (!s) return;
    if (type === DATA) {
      const f = this.flow.get(id);
      if (f) {
        f.inflight += payload.length;
        f.ungranted += payload.length;
        // A sender past its window does not keep to the protocol.
        if (f.inflight > STREAM_WINDOW) return void s.destroy(new Error('stream over its window'));
      }
      s.push(Buffer.from(payload));
      return;
    } else if (type === END) s.push(null);
    else if (type === RST) {
      this.streams.delete(id);
      let why = 'reset';
      try {
        why = String((JSON.parse(payload.toString('utf8')) as { error?: string }).error ?? why);
      } catch {
        /* a bare reset */
      }
      s.destroy(new Error(why));
    }
  }

  private async onMessage(msg: Message): Promise<void> {
    if (msg.t === 'ping') return void this.send({ t: 'pong' });
    if (msg.t === 'pong') return;
    if (msg.t === 'res') {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String(msg.error ?? 'failed')));
      return;
    }
    if (msg.t === 'req') {
      const fn = this.handlers.get(String(msg.op));
      try {
        if (!fn) throw new Error(`unknown op ${String(msg.op)}`);
        const result = await fn(msg);
        this.send({ t: 'res', id: msg.id, ok: true, result: result ?? null });
      } catch (err) {
        this.send({ t: 'res', id: msg.id, ok: false, error: String((err as Error).message ?? err).slice(0, 20_000) });
      }
      return;
    }
    this.emit('message', msg);
  }
}
