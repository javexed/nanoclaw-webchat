/**
 * Reaching a workload that runs on a worker (Scaling phase 3). A workload's
 * service address (198.18.x.y) exists on its worker only; central's `/apps/`
 * proxy, its WebSocket relay and the egress filter (an agent's own stack)
 * ask here first, and get a stream over the worker's link instead of a TCP
 * connection from this host. The workloads module registers the lookup, so
 * the gateway and the filter do not import it.
 */
import type { Duplex } from 'stream';

/** For an address on a worker: a function opening a stream to it; null when it is not one. */
export type TunnelLookup = (host: string, port: number) => Promise<(() => Duplex) | null>;

const lookups: TunnelLookup[] = [];

export function registerWorkloadTunnel(fn: TunnelLookup): void {
  lookups.push(fn);
}

export async function workloadTunnel(host: string, port: number): Promise<(() => Duplex) | null> {
  for (const fn of lookups) {
    const open = await fn(host, port).catch(() => null);
    if (open) return open;
  }
  return null;
}

export function __resetWorkloadTunnelsForTest(): void {
  lookups.length = 0;
}
