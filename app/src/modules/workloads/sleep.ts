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
import { notifyWorkloadAgent } from './notify.js';
import { workloadSetting } from './settings.js';
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

/** Hours without traffic before a stack sleeps, unless it sets its own (NANOCLAW_WORKLOAD_SLEEP_H, default 8; 0 = never). */
export const defaultSleepH = (): number => {
  const n = Number(workloadSetting('NANOCLAW_WORKLOAD_SLEEP_H') ?? 8);
  return Number.isFinite(n) && n >= 0 ? n : 8;
};
const HOUR = 3_600_000;

/** Hours this stack may sit idle before it sleeps; 0 = never. */
export const sleepAfterH = (w: Pick<Workload, 'sleepAfterH'>): number => w.sleepAfterH ?? defaultSleepH();

/** Is a running stack due to sleep? Idle since its last request and its last deploy. */
export function sleepDue(w: Workload, now: number, lastTraffic: number): boolean {
  const h = sleepAfterH(w);
  if (w.state !== 'running' || h <= 0) return false;
  return now - Math.max(lastTraffic, w.updatedAt) >= h * HOUR;
}

/**
 * Stop an idle stack and mark it asleep. The row is read again after the stop:
 * if something changed it meanwhile (a deploy, a start), that wins.
 */
export async function sleepWorkload(w: Workload, now = Date.now()): Promise<Workload | null> {
  await compose(w, ['stop'], 300_000);
  const after = await getWorkload(w.id);
  if (!after || after.state !== 'running' || after.updatedAt !== w.updatedAt) return null;
  audit({
    type: 'workload.sleep',
    actor: 'system',
    effect: 'allow',
    detail: { workload: w.id, name: w.name, idleH: sleepAfterH(w) },
  });
  return updateWorkload(w.id, { state: 'stopped', asleepAt: now }, now);
}

const waking = new Map<string, Promise<void>>();
/** When a wake last failed: no new attempt for WAKE_RETRY_MS, so every visit does not start one. */
const wakeFailedAt = new Map<string, number>();
export const WAKE_RETRY_MS = 5 * 60_000;

/** Is this stack starting up after a sleep right now? */
export const isWaking = (id: string): boolean => waking.has(id);

/** Deploys in progress (control.ts registers its own), which a sleep must never stop. */
let deployBusy: (id: string) => boolean = () => false;
export function registerDeployBusy(fn: (id: string) => boolean): void {
  deployBusy = fn;
}

/**
 * Wake a sleeping stack; once at a time per stack. Resolves when it runs (or
 * failed: the failure is recorded on the workload, logged, and the agent told).
 */
export function wakeWorkload(id: string): Promise<void> {
  const busy = waking.get(id);
  if (busy) return busy;
  const run = (async () => {
    const w = await getWorkload(id);
    if (!w || w.state !== 'stopped' || w.asleepAt === null) return;
    try {
      await compose(w, ['start'], 300_000);
      wakeFailedAt.delete(id);
      await updateWorkload(w.id, { state: 'running', asleepAt: null, lastError: null });
      audit({ type: 'workload.wake', actor: `agent:${w.agentGroupId}`, effect: 'allow', detail: { workload: w.id } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      wakeFailedAt.set(id, Date.now());
      log.warn('Workload did not wake', { workload: w.id, name: w.name, err: msg });
      await updateWorkload(w.id, { lastError: `did not wake: ${msg.slice(-500)}` });
      await notifyWorkloadAgent(
        w.agentGroupId,
        `[System] Your workload "${w.name}" was asleep and did not start again when it was used: ${msg.slice(-300)}. Look at \`ncl workloads logs --name ${w.name}\`, then \`ncl workloads start --name ${w.name}\`. Until then people opening it are told it could not start.`,
      ).catch(() => undefined);
    }
  })().finally(() => waking.delete(id));
  waking.set(id, run);
  return run;
}

/**
 * Put idle stacks to sleep. Called by the module sweep; a slow stop holds only
 * that stack. Each one is read again right before it is stopped, so a request,
 * a deploy or a start since the list was taken keeps it running.
 */
export async function sleepSweep(now = Date.now(), traffic: (id: string) => number = trafficAt): Promise<string[]> {
  const slept: string[] = [];
  for (const listed of await listWorkloads()) {
    if (!sleepDue(listed, now, traffic(listed.id))) continue;
    const w = await getWorkload(listed.id);
    if (!w || deployBusy(w.id) || !sleepDue(w, Math.max(now, Date.now()), traffic(w.id))) continue;
    try {
      if (await sleepWorkload(w, now)) {
        slept.push(w.name);
        log.info('Workload asleep', { workload: w.id, name: w.name });
      }
    } catch (e) {
      log.warn('Workload did not sleep', { workload: w.id, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return slept;
}

export type UseState = 'running' | 'starting' | 'failed';

/**
 * A request for this stack arrived (gateway check, agent's proxy): count it,
 * and wake the stack if it sleeps. 'starting' while it starts, so the caller
 * answers "Starting…" (or waits) instead of dialling stopped containers;
 * 'failed' for a while after a wake failed, so visitors get an answer instead
 * of a page that reloads forever.
 */
export async function wakeOnUse(id: string, now = Date.now()): Promise<UseState> {
  noteTraffic(id, now);
  if (isWaking(id)) return 'starting';
  const w = await getWorkload(id);
  if (!w || w.state !== 'stopped' || w.asleepAt === null) return 'running';
  if (now - (wakeFailedAt.get(id) ?? -Infinity) < WAKE_RETRY_MS) return 'failed';
  void wakeWorkload(id);
  return 'starting';
}

export function __resetSleepForTest(): void {
  lastTraffic.clear();
  waking.clear();
  wakeFailedAt.clear();
  deployBusy = () => false;
}
