/**
 * Where an agent may connect: one policy for every agent, enforced wherever
 * its traffic leaves.
 *
 * - A runner agent's container has no network; every connection rides the
 *   relay to central (runner-relay.ts), which checks here before terminating
 *   it at the OneCLI gateway as that agent.
 * - A local agent set to anything but Open runs on the internal lockdown
 *   network, where its proxy resolves to central's egress filter
 *   (egress-filter.ts), which checks here before forwarding to the gateway.
 *
 * Without this the gateway goes anywhere: measured 2026-09-23, example.com,
 * npm, PyPI and GitHub all answered — for "Locked down" local agents too, since
 * lockdown only removed direct routes, never the gateway's.
 *
 * The group's network mode chooses the rule:
 *   'open'       anything — only when chosen (stored as 'open')
 *   'host-only'  "Allowlist": the model, central's own services, the install
 *                allowlist and the agent's own hosts — also what an UNSET
 *                mode means
 *   'none'       "Model only": the model and central's own services
 *
 * Patterns: `host` (exact) or `*.suffix` (any subdomain, not the apex), each
 * optionally `:port`; without a port, 443 and 80.
 */
import net from 'net';

import { audit } from '../../audit.js';
import { EGRESS_EXTRA_DEFAULTS } from '../../config.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { log } from '../../log.js';

import {
  getAgentEgressHostsRaw,
  getEffectiveModelForAgent,
  getRunnerEgressAllowlistRaw,
  setAgentEgressHostsRaw,
  listWebchatModels,
  setRunnerEgressAllowlistRaw,
  type WebchatModel,
} from './db.js';
import { containerReachableUrl } from './models.js';

export type EgressMode = 'open' | 'host-only' | 'none';

/**
 * The model provider. Always reachable: without it the agent is not an agent.
 * This is the floor — an agent whose effective model has an endpoint (Ollama,
 * LiteLLM, any OpenAI-compatible server) gets that host too: modelHostsFor().
 */
export const ALWAYS_ALLOWED = ['api.anthropic.com'];

/** The model's host as the container dials it (`host.docker.internal:11434`, `llm.example.org:4000`), or null. */
export function modelHostPattern(model: Pick<WebchatModel, 'endpoint'> | null | undefined): string | null {
  if (!model?.endpoint) return null;
  try {
    const u = new URL(containerReachableUrl(model.endpoint));
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const p = parsePattern(`${u.hostname}:${port}`);
    return p.ok ? p.pattern : null;
  } catch {
    return null;
  }
}

/** A host-local model endpoint (loopback on the host): the filter must pass its port straight through. */
export function modelPassthrough(
  model: Pick<WebchatModel, 'endpoint'>,
): { port: number; target: { host: string; port: number } } | null {
  if (!model.endpoint) return null;
  try {
    const u = new URL(containerReachableUrl(model.endpoint));
    if (u.hostname !== 'host.docker.internal') return null;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return { port, target: { host: '127.0.0.1', port } };
  } catch {
    return null;
  }
}

/**
 * Every host-local model endpoint in the registry, as filter pass-throughs.
 * Read at spawn (the prepare hook) so a model added later gets its listener
 * at the next start; the filter's listeners are idempotent per port.
 */
export async function modelPassthroughs(): Promise<Array<{ port: number; target: { host: string; port: number } }>> {
  const out = new Map<number, { port: number; target: { host: string; port: number } }>();
  for (const m of await listWebchatModels()) {
    const p = modelPassthrough(m);
    if (p && !out.has(p.port)) out.set(p.port, p);
  }
  return [...out.values()];
}

/**
 * What this agent may always reach: the floor plus its effective model's own
 * host. Cached like the mode — this runs on every relayed connection.
 */
export async function modelHostsFor(agentGroupId: string): Promise<string[]> {
  const hit = hostsCache.get(agentGroupId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hosts;
  let hosts = [...ALWAYS_ALLOWED];
  try {
    const p = modelHostPattern(await getEffectiveModelForAgent(agentGroupId));
    if (p && !hosts.includes(p)) hosts.push(p);
  } catch (err) {
    log.warn('Egress: could not read the agent model — allowing the provider floor only', {
      agentGroupId,
      err: String(err),
    });
  }
  hostsCache.set(agentGroupId, { at: Date.now(), hosts });
  return hosts;
}

/**
 * A model was added or changed: re-read model hosts on the next connection.
 * Each agent already reaches its own model's host (modelHostsFor); nothing is
 * added to the install allowlist, which would open it for every agent.
 */
export function forgetModelHosts(): void {
  hostsCache.clear();
}

export const BUILTIN_ALLOWLIST = [
  // Packages
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'api.nuget.org',
  // Source
  'github.com',
  'api.github.com',
  'codeload.github.com',
  '*.githubusercontent.com',
  // Documentation
  'learn.microsoft.com',
];

/** The defaults: built-in, plus this install's own additions (NANOCLAW_EGRESS_EXTRA_DEFAULTS, from .env). */
export function defaultAllowlist(extra: string[] = EGRESS_EXTRA_DEFAULTS): string[] {
  const out = [...BUILTIN_ALLOWLIST];
  for (const raw of extra) {
    const p = parsePattern(raw);
    if (p.ok && !out.includes(p.pattern)) out.push(p.pattern);
    else if (!p.ok)
      log.warn('NANOCLAW_EGRESS_EXTRA_DEFAULTS: ignoring an invalid entry', { entry: raw, error: p.error });
  }
  return out;
}

const MAX_ENTRIES = 500;
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Normalize one pattern, or explain why it is not one. */
export function parsePattern(raw: string): { ok: true; pattern: string } | { ok: false; error: string } {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!s) return { ok: false, error: 'empty' };
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(s)!;
  const host = m[1];
  const port = m[2] ? Number(m[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return { ok: false, error: `bad port in ${raw}` };
  if (!HOST_RE.test(host)) return { ok: false, error: `not a host name or *.domain pattern: ${raw}` };
  return { ok: true, pattern: port ? `${host}:${port}` : host };
}

/** Validate and normalize a whole list (deduplicated, order kept). */
export function parseAllowlist(raw: unknown): { ok: true; patterns: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'allowlist must be an array of host patterns' };
  if (raw.length > MAX_ENTRIES) return { ok: false, error: `at most ${MAX_ENTRIES} entries` };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'every entry must be a string' };
    const p = parsePattern(item);
    if (!p.ok) return p;
    if (!out.includes(p.pattern)) out.push(p.pattern);
  }
  return { ok: true, patterns: out };
}

const DNS_NAME =
  /^(?=.{1,253}\.?$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*\.?$/i;

/**
 * A destination host fit to go into a CONNECT line: a DNS name or an IP
 * literal (IPv6 without brackets), nothing else. The host arrives from a
 * runner frame or an agent's proxy request, and the allowlist check is a
 * suffix match, so anything that could carry CR, LF or spaces into the
 * gateway request has to be refused before it is matched or forwarded.
 */
export function isSafeEgressHost(host: string): boolean {
  return net.isIP(host) !== 0 || DNS_NAME.test(host);
}

export function hostMatches(host: string, port: number, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const [pHost, pPort] = pattern.split(':');
  if (pPort ? Number(pPort) !== port : port !== 443 && port !== 80) return false;
  if (pHost.startsWith('*.')) return h.endsWith(pHost.slice(1)) && h.length > pHost.length - 1;
  return h === pHost;
}

/** A group's stored egress, read with its default: unset (or anything unknown) is the allowlist. */
export function effectiveEgressMode(stored: string | null | undefined): EgressMode {
  return stored === 'open' || stored === 'none' ? stored : 'host-only';
}

export function egressAllowed(
  mode: EgressMode,
  host: string,
  port: number,
  allowlist: string[],
  always: string[] = ALWAYS_ALLOWED,
): boolean {
  if (mode === 'open') return true;
  if (always.some((p) => hostMatches(host, port, p))) return true;
  if (mode === 'none') return false;
  return allowlist.some((p) => hostMatches(host, port, p));
}

// ── configuration, cached briefly: this is on every relayed connection ─────────

const TTL_MS = 15_000;
let listCache: { at: number; list: string[] } | null = null;
const modeCache = new Map<string, { at: number; mode: EgressMode }>();
const agentListCache = new Map<string, { at: number; list: string[] }>();
const hostsCache = new Map<string, { at: number; hosts: string[] }>();

export async function getRunnerEgressAllowlist(): Promise<string[]> {
  if (listCache && Date.now() - listCache.at < TTL_MS) return listCache.list;
  let list = defaultAllowlist();
  try {
    const raw = await getRunnerEgressAllowlistRaw();
    if (raw) {
      const parsed = parseAllowlist(JSON.parse(raw));
      if (parsed.ok) list = parsed.patterns;
      else log.warn('Runner egress allowlist in the database is invalid — using the default', { error: parsed.error });
    }
  } catch (err) {
    log.warn('Runner egress allowlist unreadable — using the default', { err: String(err) });
  }
  listCache = { at: Date.now(), list };
  return list;
}

export async function setRunnerEgressAllowlist(patterns: string[]): Promise<void> {
  await setRunnerEgressAllowlistRaw(JSON.stringify(patterns));
  listCache = { at: Date.now(), list: patterns };
  for (const p of patterns)
    for (const k of [...blocked.keys()])
      if (hostMatches(blocked.get(k)!.host, blocked.get(k)!.port, p)) blocked.delete(k);
}

/** One agent's own hosts, on top of the install allowlist. Unreadable reads as none: never wider. */
export async function getAgentEgressHosts(agentGroupId: string): Promise<string[]> {
  const hit = agentListCache.get(agentGroupId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
  let list: string[] = [];
  try {
    const raw = await getAgentEgressHostsRaw(agentGroupId);
    if (raw) {
      const parsed = parseAllowlist(JSON.parse(raw));
      if (parsed.ok) list = parsed.patterns;
      else
        log.warn('Agent egress hosts in the database are invalid — ignoring them', {
          agentGroupId,
          error: parsed.error,
        });
    }
  } catch (err) {
    log.warn('Agent egress hosts unreadable — applying the install allowlist only', { agentGroupId, err: String(err) });
  }
  agentListCache.set(agentGroupId, { at: Date.now(), list });
  return list;
}

export async function setAgentEgressHosts(agentGroupId: string, patterns: string[]): Promise<void> {
  await setAgentEgressHostsRaw(agentGroupId, patterns.length ? JSON.stringify(patterns) : null);
  agentListCache.set(agentGroupId, { at: Date.now(), list: patterns });
  // Allowed for this agent only: drop it from each refused host it now matches.
  for (const [k, b] of [...blocked]) {
    if (!b.agentGroupIds.includes(agentGroupId) || !patterns.some((p) => hostMatches(b.host, b.port, p))) continue;
    b.agentGroupIds = b.agentGroupIds.filter((id) => id !== agentGroupId);
    if (!b.agentGroupIds.length) blocked.delete(k);
  }
}

/** What an agent on Allowlist may reach besides the model: the install allowlist plus its own hosts. */
export async function allowlistFor(agentGroupId: string): Promise<string[]> {
  const install = await getRunnerEgressAllowlist();
  const own = await getAgentEgressHosts(agentGroupId);
  return own.length ? [...install, ...own.filter((p) => !install.includes(p))] : install;
}

export async function groupEgressMode(agentGroupId: string): Promise<EgressMode> {
  if (forcedMode) return forcedMode;
  const hit = modeCache.get(agentGroupId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.mode;
  let mode: EgressMode = 'host-only';
  try {
    // Unset means the allowlist: open egress must be a decision, not a default.
    mode = effectiveEgressMode((await getContainerConfig(agentGroupId))?.egress);
  } catch (err) {
    // Unknown is not open: fail to the allowlist rather than to anywhere.
    log.warn('Runner egress: could not read the group network mode — applying the allowlist', {
      agentGroupId,
      err: String(err),
    });
    mode = 'host-only';
  }
  modeCache.set(agentGroupId, { at: Date.now(), mode });
  return mode;
}

export function forgetGroupEgressMode(agentGroupId: string): void {
  modeCache.delete(agentGroupId);
  hostsCache.delete(agentGroupId);
  agentListCache.delete(agentGroupId);
}

// ── what was refused, for the admin's "Allow" button ────────────────────────────

export interface BlockedHost {
  host: string;
  port: number;
  count: number;
  firstAt: number;
  lastAt: number;
  agentGroupIds: string[];
}
const MAX_BLOCKED = 200;
const blocked = new Map<string, BlockedHost>();
const auditedAt = new Map<string, number>();

export function recordBlocked(
  host: string,
  port: number,
  agentGroupId: string,
  sessionId: string,
  mode: EgressMode,
): void {
  const k = `${host.toLowerCase()}:${port}`;
  const now = Date.now();
  const b = blocked.get(k) ?? {
    host: host.toLowerCase(),
    port,
    count: 0,
    firstAt: now,
    lastAt: now,
    agentGroupIds: [],
  };
  b.count += 1;
  b.lastAt = now;
  if (!b.agentGroupIds.includes(agentGroupId)) b.agentGroupIds.push(agentGroupId);
  blocked.delete(k);
  blocked.set(k, b); // most recent last
  while (blocked.size > MAX_BLOCKED) blocked.delete(blocked.keys().next().value!);
  // One audit row per host a minute is plenty; the counter keeps the rest.
  const last = auditedAt.get(k) ?? 0;
  if (now - last > 60_000) {
    auditedAt.set(k, now);
    audit({
      type: 'runner.egress.blocked',
      actor: `agent-group:${agentGroupId}`,
      effect: 'deny',
      detail: { target: `${host}:${port}`, mode, agentGroupId, sessionId, count: b.count },
    });
  }
}

export function listBlocked(): BlockedHost[] {
  return [...blocked.values()].reverse().map((b) => ({
    host: b.host,
    port: b.port,
    count: b.count,
    firstAt: b.firstAt,
    lastAt: b.lastAt,
    agentGroupIds: [...b.agentGroupIds],
  }));
}

/** The message a refused agent (and its developer) sees. */
export function blockedMessage(host: string, port: number, mode: EgressMode): string {
  const where = port === 443 || port === 80 ? host : `${host}:${port}`;
  return mode === 'none'
    ? `blocked by NanoClaw network policy: this agent may reach only the model (${where} refused)`
    : `blocked by NanoClaw network policy: ${where} is not on the allowlist — an admin can allow it in Manage → Network, or on this agent's Network list`;
}

/** Tests: fix every group's mode, the allowlist and agents' own hosts without a database. */
export function __setRunnerEgressForTest(opts: {
  mode?: EgressMode;
  allowlist?: string[];
  agentHosts?: Record<string, string[]>;
}): void {
  const far = Date.now() + 10 * 365 * 24 * 3600 * 1000;
  if (opts.allowlist) listCache = { at: far, list: opts.allowlist };
  for (const [id, list] of Object.entries(opts.agentHosts ?? {})) agentListCache.set(id, { at: far, list });
  if (opts.mode) {
    const mode = opts.mode;
    modeCache.clear();
    forcedMode = mode;
  }
}
let forcedMode: EgressMode | null = null;

export function __resetRunnerEgressForTest(): void {
  forcedMode = null;
  listCache = null;
  modeCache.clear();
  hostsCache.clear();
  agentListCache.clear();
  blocked.clear();
  auditedAt.clear();
}
