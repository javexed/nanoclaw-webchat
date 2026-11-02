/**
 * The machine link's wire format (Scaling phase 3): one mutual-TLS socket
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

const HEADER = 9;
/** Bigger payloads are split into frames of this size. */
const CHUNK = 64 * 1024;
/** A single JSON message may not exceed this (requests carry small files at most). */
export const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_FRAME = MAX_MESSAGE;
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
    if (!this.socket.destroyed) this.socket.destroy();
    this.emit('close', err);
  }

  private stream(id: number): Duplex {
    let ended = false;
    const s = new Duplex({
      read: () => undefined,
      write: (chunk: Buffer, _enc, cb) => {
        if (this.closed) return cb(new Error('link closed'));
        for (let i = 0; i < chunk.length; i += CHUNK) this.socket.write(frame(DATA, id, chunk.subarray(i, i + CHUNK)));
        cb();
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
        cb(err);
      },
    });
    s.on('end', () => {
      ended = true;
      if (s.writableFinished) this.streams.delete(id);
    });
    this.streams.set(id, s);
    return s;
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
      // A stream the other side opened must never crash this process with an unhandled error.
      s.on('error', () => undefined);
      if (!this.streamHandler) return void s.destroy(new Error('streams not accepted'));
      this.streamHandler(meta, s);
      return;
    }
    const s = this.streams.get(id);
    if (!s) return;
    if (type === DATA) s.push(Buffer.from(payload));
    else if (type === END) s.push(null);
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
