/**
 * Published apps of stacks on worker machines. A workload's service address
 * exists on its worker only, so Caddy (on this host's network) cannot dial it.
 * For each such app NanoClaw listens on a loopback port here and carries each
 * connection over the worker's link (worker-main.ts `tcp`, which reaches
 * workload addresses only); Caddy's site for the app points at that port.
 * Every request still passes the gateway's check first (forward_auth).
 */
import net from 'net';

import { log } from '../../../log.js';
import { isLinked, openWorkerTcp } from '../../machines/links.js';

interface Relay {
  server: net.Server;
  port: number;
}

const relays = new Map<string, Relay>();
const keyOf = (node: string, target: string): string => `${node}|${target}`;

/** A loopback address:port here that reaches `target` (address:port) on the worker `node`; null when it is not linked. */
export async function relayFor(node: string, target: string): Promise<string | null> {
  if (!isLinked(node)) return null;
  const k = keyOf(node, target);
  const have = relays.get(k);
  if (have) return `127.0.0.1:${have.port}`;
  const [host, p] = target.split(':');
  const server = net.createServer((sock) => {
    sock.on('error', () => undefined);
    let up: ReturnType<typeof openWorkerTcp>;
    try {
      up = openWorkerTcp(node, host, Number(p));
    } catch {
      return void sock.destroy();
    }
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
    sock.pipe(up);
    up.pipe(sock);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
  server.on('error', (err) => log.warn('Workload gateway: relay failed', { node, target, err: String(err) }));
  server.unref();
  relays.set(k, { server, port });
  return `127.0.0.1:${port}`;
}

/** Is this a relay NanoClaw opened (what a Caddy site may point at besides a workload address)? */
export function isRelayTarget(t: string): boolean {
  const m = /^127\.0\.0\.1:(\d{1,5})$/.exec(t);
  return !!m && [...relays.values()].some((r) => r.port === Number(m[1]));
}

/** Close the relays no live site uses any more. */
export function keepRelays(targets: Set<string>): void {
  for (const [k, r] of relays)
    if (!targets.has(`127.0.0.1:${r.port}`)) {
      r.server.close();
      relays.delete(k);
    }
}

export function __resetRelaysForTest(): void {
  for (const r of relays.values()) r.server.close();
  relays.clear();
}
