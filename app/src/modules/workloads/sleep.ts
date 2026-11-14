/**
 * Idle stacks sleep. A running stack with no traffic for its sleep time (the
 * default, or its own via `ncl workloads sleep`; 0 = never) is stopped and
 * marked asleep. The next request to it (its published page through the
 * gateway, the agent's own proxied access) wakes it with `compose start`:
 * seconds, not a rebuild.
 * Its containers, volumes, addresses and reserved size stay, so waking never
 * needs a new placement. An agent's `ncl workloads start` or `redeploy` also
 * wakes it; a stack an agent stopped itself is not asleep and does not wake.
 */
import { audit } from '../../audit.js';
import { log } from '../../log.js';
import { compose } from './docker.js';
import { getWorkload, listWorkloads, updateWorkload, type Workload } from './store.js';

// When each stack last had a request. In memory: after a restart every stack
// counts as used at start-up, so a restart never puts a busy stack to sleep.
const STARTED_AT = Date.now();
const lastTraffic = new Map<string, number>();

/** A request reached this stack (the gateway, or the agent's own proxy). */
export function noteTraffic(id: string, now = Date.now()): void {
  lastTraffic.set(id, now);
}

/** When this stack last had a request (start-up time if none since). */
export const trafficAt = (id: string): number => lastTraffic.get(id) ?? STARTED_AT;

/** Hours without traffic before a stack sleeps, unless it sets its own. */
export const DEFAULT_SLEEP_H = Number(process.env.NANOCLAW_WORKLOAD_SLEEP_H ?? 24);
const HOUR = 3_600_000;

/** Hours this stack may sit idle before it sleeps; 0 = never. */
export const sleepAfterH = (w: Pick<Workload, 'sleepAfterH'>): number => w.sleepAfterH ?? DEFAULT_SLEEP_H;

/** Is a running stack due to sleep? Idle since its last request and its last deploy. */
export function sleepDue(w: Workload, now: number, lastTraffic: number): boolean {
  const h = sleepAfterH(w);
  if (w.state !== 'running' || h <= 0) return false;
  return now - Math.max(lastTraffic, w.updatedAt) >= h * HOUR;
}

export async function sleepWorkload(w: Workload, now = Date.now()): Promise<Workload> {
  await compose(w, ['stop'], 300_000);
  audit({
    type: 'workload.sleep',
    actor: 'system',
    effect: 'allow',
    detail: { workload: w.id, name: w.name, idleH: sleepAfterH(w) },
  });
  return updateWorkload(w.id, { state: 'stopped', asleepAt: now }, now);
}

const waking = new Map<string, Promise<void>>();

/** Is this stack starting up after a sleep right now? */
export const isWaking = (id: string): boolean => waking.has(id);

/**
 * Wake a sleeping stack; once at a time per stack. Resolves when it runs (or
 * failed: the failure is recorded on the workload and logged).
 */
export function wakeWorkload(id: string): Promise<void> {
  const busy = waking.get(id);
  if (busy) return busy;
  const run = (async () => {
    const w = await getWorkload(id);
    if (!w || w.state !== 'stopped' || w.asleepAt === null) return;
    try {
      await compose(w, ['start'], 300_000);
      await updateWorkload(w.id, { state: 'running', asleepAt: null, lastError: null });
      audit({ type: 'workload.wake', actor: `agent:${w.agentGroupId}`, effect: 'allow', detail: { workload: w.id } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('Workload did not wake', { workload: w.id, name: w.name, err: msg });
      await updateWorkload(w.id, { lastError: `did not wake: ${msg}` });
    }
  })().finally(() => waking.delete(id));
  waking.set(id, run);
  return run;
}

/** Put idle stacks to sleep. Called by the module sweep; a slow stop holds only that stack. */
export async function sleepSweep(now = Date.now(), traffic: (id: string) => number = trafficAt): Promise<string[]> {
  const slept: string[] = [];
  for (const w of await listWorkloads()) {
    if (!sleepDue(w, now, traffic(w.id))) continue;
    try {
      await sleepWorkload(w, now);
      slept.push(w.name);
      log.info('Workload asleep', { workload: w.id, name: w.name });
    } catch (e) {
      log.warn('Workload did not sleep', { workload: w.id, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return slept;
}

/**
 * A request for this stack arrived (gateway check, agent's proxy): count it,
 * and wake the stack if it sleeps. True while it is asleep or starting, so the
 * caller answers "Starting…" instead of dialling stopped containers.
 */
export async function wakeOnUse(id: string): Promise<boolean> {
  noteTraffic(id);
  if (isWaking(id)) return true;
  const w = await getWorkload(id);
  if (!w || w.state !== 'stopped' || w.asleepAt === null) return false;
  void wakeWorkload(id);
  return true;
}

export function __resetSleepForTest(): void {
  lastTraffic.clear();
  waking.clear();
}
