/**
 * Whether each registered Ollama host answers, and where an agent's model
 * runs when its own host does not.
 *
 * The sweep (model-host-sync.ts) asks every host for /api/tags once a minute
 * and records the answer here, in memory. At spawn, an agent whose Ollama
 * model sits on a host that is down is pointed at another host that is up
 * and serves the same model (or a context variant of it). The assignment
 * itself never changes: the next spawn after the host is back uses it again.
 */
import { log } from '../../log.js';

import { getEffectiveModelForAgent, type WebchatModel } from './db.js';

export interface HostHealth {
  status: 'up' | 'down';
  /** When the host last answered, or null when it never has since boot. */
  lastOk: number | null;
  lastError: string | null;
  checkedAt: number;
  /** The tags the host listed at its last answer. */
  models: string[];
  /** A registry host — one an agent may be moved to (it has a relay); else only probed (the classifier's). */
  registered: boolean;
}

export const HOST_CHECK_TIMEOUT_MS = 3000;

const health = new Map<string, HostHealth>();

/** A registry endpoint as a host key: no trailing slash. */
export function hostKey(endpoint: string | null | undefined): string {
  return (endpoint ?? '').trim().replace(/\/+$/, '');
}

/** The distinct Ollama hosts the registry names. */
export function registeredOllamaHosts(models: Array<Pick<WebchatModel, 'kind' | 'endpoint'>>): string[] {
  const out = new Set<string>();
  for (const m of models) if (m.kind === 'ollama' && m.endpoint) out.add(hostKey(m.endpoint));
  out.delete('');
  return [...out].sort();
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One /api/tags probe. Never throws. */
export async function probeHost(
  host: string,
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; models: string[]; error: string | null }> {
  try {
    const res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(HOST_CHECK_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
    return { ok: true, models: (body.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean), error: null };
  } catch (err) {
    return { ok: false, models: [], error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

/**
 * Probe these hosts and record the results; hosts no longer listed are
 * forgotten. Returns the hosts whose status changed (a first answer counts).
 */
export async function checkHosts(
  hosts: string[],
  fetchImpl: FetchLike,
  now = Date.now(),
  extra: string[] = [],
): Promise<string[]> {
  const registered = new Set(hosts.map(hostKey));
  const wanted = new Set([...registered, ...extra.map(hostKey)]);
  wanted.delete('');
  for (const h of [...health.keys()]) if (!wanted.has(h)) health.delete(h);
  const changed: string[] = [];
  await Promise.all(
    [...wanted].map(async (host) => {
      const r = await probeHost(host, fetchImpl);
      const prev = health.get(host);
      const status = r.ok ? 'up' : 'down';
      health.set(host, {
        status,
        lastOk: r.ok ? now : (prev?.lastOk ?? null),
        lastError: r.ok ? null : r.error,
        checkedAt: now,
        models: r.ok ? r.models : (prev?.models ?? []),
        registered: registered.has(host),
      });
      if (prev?.status !== status) {
        changed.push(host);
        if (prev || status === 'down') log.info('Model host status', { host, status, error: r.error ?? undefined });
      }
    }),
  );
  return changed.sort();
}

export function getHostHealth(host: string): HostHealth | undefined {
  return health.get(hostKey(host));
}

export function hostHealthSnapshot(): Record<string, HostHealth> {
  return Object.fromEntries(health);
}

/** Test hook. */
export function _setHostHealthForTest(host: string, h: Partial<HostHealth> & { status: 'up' | 'down' }): void {
  health.set(hostKey(host), { lastOk: null, lastError: null, checkedAt: 0, models: [], registered: true, ...h });
}
export function _resetHostHealthForTest(): void {
  health.clear();
  moved.clear();
}

const CTX_SUFFIX = /-ctx\d+k$/;

/** An Ollama ref without `:latest` — the form two names are compared in. */
function bareRef(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/:latest$/, '');
}

/** The model a context variant was made from: `qwen3:8b-ctx12k` → `qwen3:8b`. */
export function baseModelRef(id: string): string {
  return bareRef(id).replace(CTX_SUFFIX, '');
}

function ctxOf(id: string): number {
  const m = /-ctx(\d+)k$/.exec(bareRef(id));
  return m ? Number(m[1]) : 0;
}

/**
 * Where this model runs when its host is down: another host that is up and
 * lists the same model (preferred), else a context variant of the same base
 * model (the largest window first). Null when the model's host is not known
 * to be down, or no other host serves it.
 */
export function failoverTarget(
  model: Pick<WebchatModel, 'kind' | 'endpoint' | 'model_id'>,
  state: Record<string, HostHealth> = hostHealthSnapshot(),
): { endpoint: string; model_id: string } | null {
  if (model.kind !== 'ollama' || !model.endpoint) return null;
  const own = hostKey(model.endpoint);
  if (state[own]?.status !== 'down') return null;
  const want = bareRef(model.model_id);
  const base = baseModelRef(model.model_id);
  let similar: { endpoint: string; model_id: string; ctx: number } | null = null;
  for (const host of Object.keys(state).sort()) {
    const h = state[host];
    if (host === own || h.status !== 'up' || !h.registered) continue;
    const exact = h.models.find((t) => bareRef(t) === want);
    if (exact) return { endpoint: host, model_id: exact };
    for (const t of h.models) {
      if (baseModelRef(t) !== base) continue;
      const ctx = ctxOf(t);
      if (!similar || ctx > similar.ctx) similar = { endpoint: host, model_id: t, ctx };
    }
  }
  return similar ? { endpoint: similar.endpoint, model_id: similar.model_id } : null;
}

/** What each agent was last moved to, so a move is logged once, not at every read. */
const moved = new Map<string, string>();

/** Whether this agent's last spawn model was a failover. */
export function isMovedOffHost(agentGroupId: string): boolean {
  return moved.has(agentGroupId);
}

/**
 * The model an agent spawns on: its own, or the failover when its host is
 * down. Same row otherwise (id, name, kind), so callers treat it as the model.
 */
export function spawnModel<T extends WebchatModel | null>(model: T, agentGroupId = ''): T {
  if (!model) return model;
  const to = failoverTarget(model);
  const key = to ? `${to.endpoint} ${to.model_id}` : '';
  if ((moved.get(agentGroupId) ?? '') !== key) {
    if (to) {
      moved.set(agentGroupId, key);
      log.info('Model host down — the agent uses another host until it is back', {
        agentGroupId,
        model: model.model_id,
        from: hostKey(model.endpoint),
        to: to.endpoint,
        as: to.model_id,
      });
    } else moved.delete(agentGroupId);
  }
  return to ? { ...model, endpoint: to.endpoint, model_id: to.model_id } : model;
}

/**
 * pi's model at spawn when its host is down and another serves it: the
 * wiring file names the assigned host, so the move is applied on top. (The
 * container reaches a host-local server as host.docker.internal.)
 */
export async function localModelFailover(agentGroupId: string): Promise<{ baseURL: string; modelId: string } | null> {
  const own = await getEffectiveModelForAgent(agentGroupId);
  if (own?.kind !== 'ollama') return null;
  const moved = spawnModel(own, agentGroupId);
  if (moved === own || !moved.endpoint) return null;
  const base = hostKey(moved.endpoint).replace(
    /^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/,
    '$1host.docker.internal',
  );
  return { baseURL: `${base}/v1`, modelId: moved.model_id };
}
