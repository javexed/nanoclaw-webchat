/**
 * Keeping the router and the routing classifier on the model hosts that are
 * actually there.
 *
 *   - The router follows the roster: a model registered on a new Ollama host,
 *     or the last one on a host deleted, rebuilds the LiteLLM router with the
 *     host list changed by exactly that (debounced, so a bulk add is one
 *     rebuild). A host that comes back after the router was built without it
 *     gets the same rebuild.
 *   - Host health: every registered host is asked for /api/tags once a minute
 *     (model-host-health.ts). When the classifier's host is down and another
 *     host serves the classifier model, routes.json points at that one until
 *     its own host is back.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';

import { listWebchatModels } from './db.js';
import { cloudModelNames } from './cloud-models.js';
import { forgetModelHosts } from './egress-policy.js';
import {
  checkHosts,
  hostHealthSnapshot,
  hostKey,
  registeredOllamaHosts,
  type HostHealth,
} from './model-host-health.js';
import { containerReachableUrl, hostReachableUrl, safeFetch } from './models.js';
import {
  getRosterRefreshState,
  parseConfiguredHosts,
  readRoutesConfig,
  startRouterReinstall,
  writeRoutesConfig,
} from './ollama-manage.js';

// ── Router follows hosts ─────────────────────────────────────────────────

export const ROUTER_SYNC_DEBOUNCE_MS = 5000;
/** A recovered host triggers at most one rebuild in this window (a flapping host must not churn the router). */
const RECOVERY_COOLDOWN_MS = 10 * 60_000;

let pending = { add: new Set<string>(), remove: new Set<string>(), refresh: false };
let timer: ReturnType<typeof setTimeout> | null = null;
const recoveredAt = new Map<string, number>();

function schedule(root: string): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      flushRouterHostSync(root);
    } catch (err) {
      log.warn('Router host sync failed', { err: String(err) });
    }
  }, ROUTER_SYNC_DEBOUNCE_MS);
  timer.unref?.();
}

/** The registry's Ollama hosts now — what a caller snapshots before and after a change. */
export async function rosterHosts(): Promise<string[]> {
  return registeredOllamaHosts(await listWebchatModels());
}

/** A registry change moved the set of Ollama hosts (or did not — then nothing happens). */
export function noteRosterHosts(before: string[], after: string[], root = process.cwd()): void {
  const b = new Set(before.map(hostKey));
  const a = new Set(after.map(hostKey));
  const added = [...a].filter((h) => !b.has(h));
  const removed = [...b].filter((h) => !a.has(h));
  if (added.length === 0 && removed.length === 0) return;
  for (const h of added) {
    pending.remove.delete(h);
    pending.add.add(h);
  }
  for (const h of removed) {
    pending.add.delete(h);
    pending.remove.add(h);
  }
  schedule(root);
}

/** Hosts config.yaml has deployments for (its api_base lines, in the container's form). */
function deployedBases(configText: string): Set<string> {
  const out = new Set<string>();
  for (const m of configText.matchAll(/^\s*api_base:\s*"?([^"\s]+)"?\s*$/gm)) out.add(m[1].replace(/\/+$/, ''));
  return out;
}

/** config.yaml's host list with one batch of roster changes applied. */
function withDelta(list: string[], p: { add: Set<string>; remove: Set<string> }): string[] {
  const next = list.filter((h) => !p.remove.has(hostKey(h)));
  for (const h of p.add) if (!next.some((x) => hostKey(x) === h)) next.push(h);
  return next;
}

/** Rebuilds queued from here whose host list has not been worked out yet. */
let unresolved = 0;

/**
 * Apply what has piled up: rebuild the router through the one chain every
 * rebuild takes, behind its install lock. Returns whether a rebuild started.
 *
 * Only this batch's changes travel with the rebuild; the list they apply to
 * is read when it runs. Rebuilds wait on each other, so one queued ahead of
 * this may still rewrite config.yaml's header — applying the change to the
 * header as it is now would undo that one.
 */
export function flushRouterHostSync(root = process.cwd()): boolean {
  const p = pending;
  pending = { add: new Set(), remove: new Set(), refresh: false };
  if (timer) clearTimeout(timer);
  timer = null;
  if (!getRosterRefreshState(root).available) return false; // no router installed
  const configPath = path.join(root, 'data/litellm/config.yaml');
  const configured = parseConfiguredHosts(fs.readFileSync(configPath, 'utf8'));
  if (configured === null) {
    log.warn('Router host sync: config.yaml has no "# hosts:" header — rebuild the router by hand once');
    return false;
  }
  const list = configured ? configured.split(',') : [];
  const next = withDelta(list, p);
  // Nothing to change — unless a queued rebuild has yet to write its header.
  if (unresolved === 0 && next.join(',') === list.join(',') && !p.refresh) return false;
  if (next.length === 0 && cloudModelNames(root).length === 0) {
    log.info('Router host sync: no model server would be left — the router is left as it is', { hosts: list });
    return false;
  }
  log.info('Model hosts changed — rebuilding the router', {
    hosts: next,
    added: [...p.add],
    removed: [...p.remove],
    refresh: p.refresh || undefined,
  });
  unresolved++;
  startRouterReinstall(root, () => {
    unresolved = Math.max(0, unresolved - 1);
    const now = parseConfiguredHosts(fs.readFileSync(configPath, 'utf8'));
    const current = now ? now.split(',') : now === '' ? [] : list;
    const hosts = withDelta(current, p);
    // Never the last model server gone with no cloud backend to serve instead.
    if (hosts.length === 0 && cloudModelNames(root).length === 0) return current.join(',');
    return hosts.join(',');
  });
  return true;
}

/**
 * Configured hosts that answer again but have no deployment in config.yaml:
 * the router was built while they were down, so it is rebuilt to serve them.
 */
function noteRecoveredHosts(changed: string[], state: Record<string, HostHealth>, root: string, now: number): void {
  if (!getRosterRefreshState(root).available) return;
  const text = fs.readFileSync(path.join(root, 'data/litellm/config.yaml'), 'utf8');
  const configured = (parseConfiguredHosts(text) ?? '').split(',').filter(Boolean).map(hostKey);
  const deployed = deployedBases(text);
  for (const host of changed) {
    if (state[host]?.status !== 'up' || !configured.includes(host)) continue;
    if (deployed.has(containerReachableUrl(host))) continue;
    if (now - (recoveredAt.get(host) ?? -Infinity) < RECOVERY_COOLDOWN_MS) continue;
    recoveredAt.set(host, now);
    pending.refresh = true;
    schedule(root);
  }
}

// ── Classifier failover ──────────────────────────────────────────────────

/** host:port with every name for this machine folded together. */
function originKey(url: string): string | null {
  try {
    const u = new URL(url);
    const host = ['localhost', '127.0.0.1', 'host.docker.internal'].includes(u.hostname) ? 'localhost' : u.hostname;
    return `${host}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
  } catch {
    return null;
  }
}

/** The health entry a classifier URL is on. */
function hostFor(url: string, state: Record<string, HostHealth>): string | null {
  const k = originKey(url);
  return Object.keys(state).find((h) => originKey(h) === k) ?? null;
}

/** The classifier's own host, host-side, for the sweep to probe. */
function classifierHome(root: string): string | null {
  try {
    const c = (readRoutesConfig(root)?.classifier ?? null) as Record<string, unknown> | null;
    const url = typeof c?.home_url === 'string' ? c.home_url : typeof c?.url === 'string' ? c.url : null;
    return url ? hostReachableUrl(new URL(url).origin) : null;
  } catch {
    return null;
  }
}

const bare = (id: string): string =>
  id
    .trim()
    .toLowerCase()
    .replace(/:latest$/, '');

/**
 * Point the router hook's classifier at a host that is up. routes.json is
 * re-read by the hook on every request and replaced atomically here, so the
 * change applies to the next request. The URL it had is kept as `home_url`
 * and put back once that host answers again.
 */
export function reconcileClassifierHost(
  root = process.cwd(),
  state: Record<string, HostHealth> = hostHealthSnapshot(),
): 'moved' | 'restored' | null {
  let cfg: Record<string, unknown> | null;
  try {
    cfg = readRoutesConfig(root);
  } catch {
    return null;
  }
  const c = cfg?.classifier as Record<string, unknown> | undefined;
  if (!cfg || !c || typeof c.url !== 'string' || typeof c.model !== 'string') return null;
  const home = typeof c.home_url === 'string' ? c.home_url : c.url;
  const homeHost = hostFor(home, state);
  if (typeof c.home_url === 'string' && homeHost && state[homeHost]?.status === 'up') {
    const from = c.url;
    c.url = home;
    delete c.home_url;
    writeRoutesConfig(cfg, root);
    if (from !== home) log.info('Classifier host is back — routing classifies there again', { url: home });
    return from !== home ? 'restored' : null;
  }
  const current = hostFor(c.url, state);
  if (!current || state[current]?.status !== 'down') return null;
  const want = bare(c.model);
  for (const host of Object.keys(state).sort()) {
    const h = state[host];
    if (host === current || h.status !== 'up' || !h.models.some((t) => bare(t) === want)) continue;
    const url = containerReachableUrl(host) + new URL(c.url).pathname;
    log.info('Classifier host down — routing classifies on another host', { from: c.url, to: url });
    c.home_url = home;
    c.url = url;
    writeRoutesConfig(cfg, root);
    return 'moved';
  }
  return null;
}

// ── The sweep ────────────────────────────────────────────────────────────

export const HOST_SWEEP_INTERVAL_MS = 60_000;

/** One pass: probe every host, then let the changes reach egress, the classifier and the router. */
export async function sweepModelHosts(root = process.cwd(), fetchImpl = safeFetch, now = Date.now()): Promise<void> {
  const registered = registeredOllamaHosts(await listWebchatModels());
  const home = classifierHome(root);
  const extra = home && !registered.some((h) => originKey(h) === originKey(home)) ? [home] : [];
  const changed = await checkHosts(registered, fetchImpl, now, extra);
  if (changed.length === 0) return;
  // Agents' allowed model hosts include a failover host now (or no longer).
  forgetModelHosts();
  const state = hostHealthSnapshot();
  try {
    reconcileClassifierHost(root, state);
  } catch (err) {
    log.warn('Classifier failover failed', { err: String(err) });
  }
  noteRecoveredHosts(changed, state, root, now);
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;

export function startModelHostSweep(root = process.cwd()): void {
  if (sweepTimer) return;
  const run = (): void => void sweepModelHosts(root).catch((err) => log.warn('Model host sweep failed', { err }));
  firstTimer = setTimeout(run, 5000);
  firstTimer.unref?.();
  sweepTimer = setInterval(run, HOST_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopModelHostSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearTimeout(timer);
  sweepTimer = firstTimer = timer = null;
}

/** Test hook. */
export function _resetHostSyncForTest(): void {
  stopModelHostSweep();
  pending = { add: new Set(), remove: new Set(), refresh: false };
  unresolved = 0;
  recoveredAt.clear();
}
