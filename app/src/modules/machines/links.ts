/**
 * Central's side of worker links: one live link per machine,
 * attached when a worker connects to the machine listener (`GET /link`,
 * upgraded), dropped when the machine is revoked or the socket goes. Health
 * arriving over the link is recorded as a report; a revoked machine's link is
 * closed on its next message at the latest.
 */
import type { Duplex } from 'stream';

import { log } from '../../log.js';
import { getMember, recordHealth } from './members.js';
import { Mux, type Message, type Socketish } from './mux.js';

const links = new Map<string, Mux>();

/**
 * Health reports a link may send: a worker reports once a minute (and once
 * more after an isolation check), so a burst of 4 and one more every 15
 * seconds is plenty. Anything over is dropped, not written: each report is
 * a database write, and a broken or hostile worker must not be able to
 * flood central with them. Logged at most once a minute per link.
 */
export const HEALTH_BURST = 4;
export const HEALTH_EVERY_MS = 15_000;

export function healthLimiter(burst = HEALTH_BURST, everyMs = HEALTH_EVERY_MS) {
  let tokens = burst;
  let last = 0;
  let dropped = 0;
  let loggedAt = -Infinity;
  return {
    /** May this report be recorded? */
    take(now = Date.now()): boolean {
      if (last) tokens = Math.min(burst, tokens + (now - last) / everyMs);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      dropped++;
      return false;
    },
    /** Reports dropped since the last log line, when a line is due (else null). */
    due(now = Date.now()): number | null {
      if (!dropped || now - loggedAt < 60_000) return null;
      loggedAt = now;
      const n = dropped;
      dropped = 0;
      return n;
    },
  };
}

/** Streams a worker opens (e.g. a workload's egress), by kind; modules register what they accept. */
export type WorkerStreamHandler = (
  machineId: string,
  meta: Record<string, unknown>,
  stream: Duplex,
) => void | Promise<void>;
const streamHandlers = new Map<string, WorkerStreamHandler>();
export function registerWorkerStream(kind: string, fn: WorkerStreamHandler): void {
  streamHandlers.set(kind, fn);
}

export function attachLink(machineId: string, socket: Socketish): Mux {
  links.get(machineId)?.close(new Error('replaced by a newer link'));
  const mux = new Mux(socket, 'central');
  links.set(machineId, mux);
  const limit = healthLimiter();
  mux.on('message', (msg: Message) => {
    if (msg.t !== 'health') return;
    if (!limit.take()) {
      const n = limit.due();
      if (n) log.warn('Worker health reports dropped: too many', { machineId, dropped: n });
      return;
    }
    void (async () => {
      const m = await getMember(machineId);
      if (!m || m.state === 'revoked') return mux.close(new Error('revoked'));
      await recordHealth(machineId, (msg.data ?? {}) as Record<string, unknown>);
    })().catch((err) => log.warn('Worker health not recorded', { machineId, err: String(err) }));
  });
  mux.onStream((meta, stream) => {
    const fn = streamHandlers.get(String(meta.kind ?? ''));
    if (!fn) return void stream.destroy(new Error('refused: unknown stream'));
    void Promise.resolve(fn(machineId, meta, stream)).catch((err) => stream.destroy(err as Error));
  });
  mux.once('close', (err: Error) => {
    if (links.get(machineId) === mux) links.delete(machineId);
    log.info('Worker link closed', { machineId, why: String(err?.message ?? err) });
  });
  log.info('Worker linked', { machineId });
  for (const fn of onLinked)
    void Promise.resolve(fn(machineId)).catch((err) =>
      log.warn('Worker link hook failed', { machineId, err: String(err) }),
    );
  return mux;
}

export const isLinked = (machineId: string): boolean => !!links.get(machineId) && !links.get(machineId)!.closed;

/** Drop a machine's link at once (revoke, remove). */
export function dropLink(machineId: string, why = 'revoked'): void {
  links.get(machineId)?.close(new Error(why));
}

function linkOf(machineId: string): Mux {
  const mux = links.get(machineId);
  if (!mux || mux.closed) throw new Error(`worker ${machineId} is not connected`);
  return mux;
}

/** Ask a worker for one of its fixed jobs (worker-main.ts). */
export async function callWorker(
  machineId: string,
  op: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<unknown> {
  return linkOf(machineId).request(op, payload, timeoutMs);
}

/** A stream to one of a worker's stream jobs (worker-main.ts: image-load, vol-out, vol-in). */
export function openWorkerStream(machineId: string, meta: Record<string, unknown>): Duplex {
  return linkOf(machineId).open(meta);
}

/** Called once each time a worker links (workloads clean up what is no longer theirs there). */
const onLinked: Array<(machineId: string) => void | Promise<void>> = [];
export function whenLinked(fn: (machineId: string) => void | Promise<void>): void {
  onLinked.push(fn);
}

/** A TCP stream to a workload's address on a worker, carried over its link. */
export function openWorkerTcp(machineId: string, host: string, port: number): Duplex {
  return linkOf(machineId).open({ kind: 'tcp', host, port });
}

export function __resetLinksForTest(): void {
  for (const m of links.values()) m.close(new Error('test reset'));
  links.clear();
}
