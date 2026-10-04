/**
 * Models on another machine (a GPU box on the LAN) for agents behind the
 * egress filter.
 *
 * Such an agent sits on the internal lockdown network, which has no route
 * out, so dialing the model directly fails. Central listens for it instead:
 * one port per model host on the lockdown bridge (egress-filter.ts), each
 * forwarding to its model and admitting only the agents whose model it is.
 * The agent's model URL names that port under host.docker.internal, as a
 * host-local model's already does. An agent on Open dials the model directly.
 */
import { createHash } from 'crypto';

import { EGRESS_LOCKDOWN } from '../../config.js';
import { getContainerConfig } from '../../db/container-configs.js';

import { listWebchatModels } from './db.js';

/** What a relay is decided on: a registry model's kind and endpoint, and when it was registered. */
type ModelEndpoint = { kind: string; endpoint: string | null; created_at?: number };

export interface ModelRelay {
  port: number;
  target: { host: string; port: number };
  /** An Ollama server: requests filtered to inference (ollama-filter.ts). */
  ollama?: boolean;
}

/** The name a container dials central by; on the lockdown network it is the filter's bridge address. */
export const RELAY_HOST = 'host.docker.internal';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', RELAY_HOST];
const RELAY_PORT_BASE = 47100;
const RELAY_PORT_SPAN = 800;

const RELAYED_KINDS = ['ollama', 'openai-compatible'];

/** host:port, the key a relay and an agent's own model are matched on. */
export const relayKey = (t: { host: string; port: number }): string => `${t.host}:${t.port}`;

/**
 * A model endpoint on another machine, or null. Plain HTTP only: over TLS
 * the agent would check the model's certificate against the relay's name.
 */
export function remoteModelTarget(endpoint: string | null | undefined): { host: string; port: number } | null {
  if (!endpoint) return null;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' || !u.hostname || LOCAL_HOSTS.includes(u.hostname)) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 80) };
  } catch {
    return null;
  }
}

/** The relay a model needs, when it is one central relays. */
function relayedTarget(m: ModelEndpoint): { host: string; port: number } | null {
  return RELAYED_KINDS.includes(m.kind) ? remoteModelTarget(m.endpoint) : null;
}

/** Ports this process has handed out, by host: a host keeps its port while it is registered. */
const assigned = new Map<string, number>();

/**
 * One listener port per distinct model host, from a hash of host:port so it
 * stays put across restarts (a running agent keeps the URL it started with).
 * A host-local model's port is never taken. A collision moves the host
 * registered LATER to the next free port, so adding a host never moves one an
 * agent may already be dialing; within a process, a host also keeps its port
 * when a host it collided with goes away.
 */
export function modelRelaysFor(models: ModelEndpoint[]): ModelRelay[] {
  const used = new Set<number>();
  for (const m of models) {
    try {
      const u = new URL(m.endpoint ?? '');
      if (LOCAL_HOSTS.includes(u.hostname)) used.add(Number(u.port || (u.protocol === 'https:' ? 443 : 80)));
    } catch {
      /* not a URL */
    }
  }
  const targets = new Map<string, { host: string; port: number; since: number }>();
  const ollamaTargets = new Set<string>();
  for (const m of models) {
    const t = relayedTarget(m);
    if (!t) continue;
    const key = relayKey(t);
    const since = Math.min(targets.get(key)?.since ?? Infinity, m.created_at ?? Infinity);
    targets.set(key, { ...t, since });
    if (m.kind === 'ollama') ollamaTargets.add(key);
  }
  for (const key of [...assigned.keys()]) if (!targets.has(key)) assigned.delete(key);
  // First-registered first, so the probing order only ever grows at the end.
  const order = [...targets.keys()].sort((a, b) => targets.get(a)!.since - targets.get(b)!.since || (a < b ? -1 : 1));
  const ports = new Map<string, number>();
  for (const key of order) {
    const kept = assigned.get(key);
    if (kept !== undefined && !used.has(kept)) {
      used.add(kept);
      ports.set(key, kept);
    }
  }
  for (const key of order) {
    if (ports.has(key)) continue;
    let slot = createHash('sha256').update(key).digest().readUInt32BE(0) % RELAY_PORT_SPAN;
    for (let i = 0; i < RELAY_PORT_SPAN && used.has(RELAY_PORT_BASE + slot); i++) slot = (slot + 1) % RELAY_PORT_SPAN;
    if (used.has(RELAY_PORT_BASE + slot)) break;
    used.add(RELAY_PORT_BASE + slot);
    ports.set(key, RELAY_PORT_BASE + slot);
  }
  const out: ModelRelay[] = [];
  for (const key of [...ports.keys()].sort()) {
    const { host, port } = targets.get(key)!;
    assigned.set(key, ports.get(key)!);
    out.push({
      port: ports.get(key)!,
      target: { host, port },
      ...(ollamaTargets.has(key) ? { ollama: true } : {}),
    });
  }
  return out;
}

/** Test hook: forget the ports handed out. */
export function _resetRelayPortsForTest(): void {
  assigned.clear();
}

/** Every relay the model registry needs. */
export async function modelRelays(): Promise<ModelRelay[]> {
  return modelRelaysFor(await listWebchatModels());
}

/** Whether this agent runs behind the egress filter: anything but an explicit Open, or every agent under the install-wide lockdown. */
export async function behindEgressFilter(agentGroupId: string): Promise<boolean> {
  if (EGRESS_LOCKDOWN) return true;
  try {
    return (await getContainerConfig(agentGroupId))?.egress !== 'open';
  } catch {
    return true;
  }
}

/**
 * The model URL this agent dials: unchanged, except a model on another
 * machine for an agent behind the egress filter, which it reaches through
 * that model's relay. On any failure, unchanged.
 */
export async function agentModelUrl(agentGroupId: string, url: string): Promise<string> {
  const target = remoteModelTarget(url);
  if (!target) return url;
  try {
    if (!(await behindEgressFilter(agentGroupId))) return url;
    const relay = (await modelRelays()).find((r) => relayKey(r.target) === relayKey(target));
    return relay ? url.replace(/^http:\/\/[^/]+/, `http://${RELAY_HOST}:${relay.port}`) : url;
  } catch {
    return url;
  }
}
