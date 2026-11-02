/**
 * Central's side of worker links (Scaling phase 3): one live link per machine,
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

export function attachLink(machineId: string, socket: Socketish): Mux {
  links.get(machineId)?.close(new Error('replaced by a newer link'));
  const mux = new Mux(socket, 'central');
  links.set(machineId, mux);
  mux.on('message', (msg: Message) => {
    if (msg.t !== 'health') return;
    void (async () => {
      const m = await getMember(machineId);
      if (!m || m.state === 'revoked') return mux.close(new Error('revoked'));
      await recordHealth(machineId, (msg.data ?? {}) as Record<string, unknown>);
    })().catch((err) => log.warn('Worker health not recorded', { machineId, err: String(err) }));
  });
  mux.once('close', (err: Error) => {
    if (links.get(machineId) === mux) links.delete(machineId);
    log.info('Worker link closed', { machineId, why: String(err?.message ?? err) });
  });
  log.info('Worker linked', { machineId });
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

/** A TCP stream to a workload's address on a worker, carried over its link. */
export function openWorkerTcp(machineId: string, host: string, port: number): Duplex {
  return linkOf(machineId).open({ kind: 'tcp', host, port });
}

export function __resetLinksForTest(): void {
  for (const m of links.values()) m.close(new Error('test reset'));
  links.clear();
}
