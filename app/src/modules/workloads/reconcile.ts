/**
 * Keeps workloads honest, from the module sweep:
 *
 *   - the preflight (preflight.ts) at the first sweep and every half hour;
 *     when it finds the host reachable from a workload network, every running
 *     stack is stopped until the host rules are back;
 *   - agents stay joined to their own networks (a new agent container starts
 *     without them; watch.ts joins most of them at start already);
 *   - every two minutes: a running stack whose containers have gone is
 *     recorded as failed, expired stacks are stopped and their agent told,
 *     and an agent is reminded once, a few days before, that a stack expires
 *     (so it can tell its room: an admin extends it in Agent → Apps); a
 *     stack whose published app people opened in the last week is renewed
 *     instead (opened.ts), the same as an Extend;
 *   - every ten minutes disk use is measured against each agent's quota
 *     (disk.ts);
 *   - once a night each stack's volumes are backed up (backup.ts), and the
 *     backups of a workload deleted a week ago are removed.
 *
 * The preflight and network joins are central's: stacks on workers are left
 * out of them (a worker checks its own host rules: worker-isolation.ts; its
 * stacks are reached over its link). Their backups are streamed here over
 * the link.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';
import { backupRoot, backupWorkload, listBackups, removeBackups, stampTime } from './backup.js';
import { deployInFlight, extendWorkload, parsePs, serviceImages, stopWorkload } from './control.js';
import { diskLevel, gb, measureDisk, recordUsage, type DiskLevel } from './disk.js';
import { isLinked } from '../machines/links.js';
import { compose, joinAgentContainers, LOCAL_NODE, workDir } from './docker.js';
import { dayText, notifyWorkloadAgent } from './notify.js';
import { lastOpened, USED_WITHIN_MS } from './opened.js';
import { preflightDue, runPreflight, type PreflightResult } from './preflight.js';
import { allNetworks, listWorkloads, quotaFor, updateWorkload, type Workload } from './store.js';
import { reconcileWorkerIsolation } from './worker-isolation.js';
import { syncWorkloadEgress } from './egress.js';

const EVERY_MS = 2 * 60_000;
const DISK_EVERY_MS = 10 * 60_000;
const BACKUP_AGE_MS = 20 * 3_600_000;
const KEEP_DELETED_MS = 7 * 86_400_000;
/** How long before its expiry an agent hears that a stack is about to stop. */
export const EXPIRY_NOTICE_MS = 3 * 86_400_000;
let last = 0;
let lastDisk = 0;
let backingUp = false;
const told = new Map<string, DiskLevel>();

/** Night-time on this host (local 01:00–05:59), when a short pause hurts least. */
const isNight = (d: Date): boolean => d.getHours() >= 1 && d.getHours() < 6;

export interface ReconcileDeps {
  preflight: () => Promise<PreflightResult>;
  stop: typeof stopWorkload;
  notify: typeof notifyWorkloadAgent;
  ps: (w: Workload) => Promise<string>;
  join: typeof joinAgentContainers;
  measure: typeof measureDisk;
  backup: typeof backupWorkload;
  workers: (now: number) => Promise<void>;
  /** Runtime egress listeners in line with what runs (egress.ts); left out in tests that do not need it. */
  egress?: () => Promise<void>;
}

const defaults: ReconcileDeps = {
  preflight: () => runPreflight(),
  stop: stopWorkload,
  notify: notifyWorkloadAgent,
  ps: (w) => compose(w, ['ps', '--all', '--format', 'json'], 60_000),
  join: joinAgentContainers,
  measure: measureDisk,
  backup: backupWorkload,
  workers: (now) => reconcileWorkerIsolation(now),
  egress: () => syncWorkloadEgress(),
};

/** Stop every running stack on this host: it is reachable from workload networks. */
async function stopAllRunning(deps: ReconcileDeps): Promise<void> {
  for (const w of (await listWorkloads()).filter(
    (x) => (x.state === 'running' || x.state === 'deploying') && x.node === LOCAL_NODE,
  )) {
    await deps
      .stop(w.agentGroupId, w.name, 'host isolation missing')
      .catch((err) => log.error('Workload could not be stopped', { workloadId: w.id, err: String(err).slice(0, 200) }));
  }
}

async function checkDisk(deps: ReconcileDeps): Promise<void> {
  // Every node's stacks count toward the agent's quota (disk.ts: Docker's use on central, backups for all).
  const live = (await listWorkloads()).filter((w) => w.state !== 'deleted');
  if (!live.length) return;
  const byAgent = recordUsage(live, await deps.measure(live, (w) => Object.values(serviceImages(w))));
  for (const [agent, bytes] of byAgent) {
    const q = await quotaFor(agent);
    const level = diskLevel(bytes, q.diskGb);
    const before = told.get(agent) ?? 'ok';
    told.set(agent, level);
    if (level === before || level === 'ok') continue;
    if (level === 'warn') {
      await deps.notify(
        agent,
        `[System] Your workloads use ${gb(bytes)} GB of your ${q.diskGb} GB disk quota. Free space before it fills: at the limit they are stopped.`,
      );
      continue;
    }
    const stopped: string[] = [];
    for (const w of live.filter((x) => x.agentGroupId === agent && x.state === 'running')) {
      await deps.stop(agent, w.name, 'disk quota').then(
        () => stopped.push(w.name),
        () => undefined,
      );
    }
    await deps.notify(
      agent,
      `[System] Your workloads use ${gb(bytes)} GB, over your ${q.diskGb} GB disk quota${stopped.length ? `; stopped: ${stopped.join(', ')}` : ''}. Free space (delete data or a stack), then \`ncl workloads start\`. An owner can raise the quota.`,
    );
  }
}

async function nightlyBackups(now: Date, deps: ReconcileDeps): Promise<void> {
  const all = await listWorkloads({ includeDeleted: true });
  for (const w of all.filter((x) => x.state === 'deleted' && now.getTime() - x.updatedAt > KEEP_DELETED_MS)) {
    if (fs.existsSync(backupRoot(w.id))) removeBackups(w.id);
  }
  if (!isNight(now)) return;
  const due = (w: Workload): boolean => {
    const newest = listBackups(w.id)[0];
    if (!newest) return true;
    const at = stampTime(newest.stamp);
    // A stopped stack's data does not change: one backup after it stopped is enough.
    if (w.state === 'stopped') return at < w.updatedAt;
    return now.getTime() - at > BACKUP_AGE_MS;
  };
  // A stack on a worker is backed up over its link, when that worker is linked.
  for (const w of all.filter(
    (x) => (x.state === 'running' || x.state === 'stopped') && (x.node === LOCAL_NODE || isLinked(x.node)),
  )) {
    if (!due(w)) continue;
    await deps
      .backup(w)
      .catch((err) => log.warn('Workload backup failed', { workloadId: w.id, err: String(err).slice(0, 300) }));
  }
}

export async function reconcileWorkloads(now = Date.now(), deps: ReconcileDeps = defaults): Promise<void> {
  if (preflightDue(now)) {
    const pre = await deps.preflight();
    if (pre.isolationOpen) await stopAllRunning(deps);
  }
  // Workers check their own isolation; central asks for a check when one is missing and records what they stopped.
  await deps.workers(now).catch((err) => log.warn('Worker isolation sweep failed', { err: String(err).slice(0, 200) }));
  // Every sweep: cheap, and a freshly started agent container cannot reach its own stacks until it has joined.
  // Only agents with a stack here: the network of a stack on a worker exists on that worker only.
  const here = new Set(
    (await listWorkloads()).filter((w) => w.node === LOCAL_NODE && w.state !== 'deleted').map((w) => w.agentGroupId),
  );
  for (const n of (await allNetworks()).filter((x) => here.has(x.agentGroupId))) {
    await deps
      .join(n.agentGroupId, n.network)
      .catch((err) =>
        log.warn('Workload network join failed', { agentGroupId: n.agentGroupId, err: String(err).slice(0, 200) }),
      );
  }
  // Cheap and in memory: re-opens listeners after a restart, closes those nothing needs.
  await deps.egress?.().catch((err) => log.warn('Workload egress sync failed', { err: String(err).slice(0, 200) }));
  if (now - lastDisk >= DISK_EVERY_MS) {
    lastDisk = now;
    await checkDisk(deps).catch((err) => log.warn('Workload disk check failed', { err: String(err).slice(0, 200) }));
  }
  // Backups can take a while: never hold the sweep for them.
  if (!backingUp) {
    backingUp = true;
    void nightlyBackups(new Date(now), deps).finally(() => (backingUp = false));
  }
  if (now - last < EVERY_MS) return;
  last = now;
  await settleInterrupted({ now }).catch((err) =>
    log.warn('Workload reconcile failed', { err: String(err).slice(0, 200) }),
  );
  for (let w of await listWorkloads()) {
    if (w.state !== 'running') continue;
    // A worker that is not linked cannot be asked: its stacks wait until it links again.
    if (w.node !== LOCAL_NODE && !isLinked(w.node)) continue;
    try {
      w = await renewIfUsed(w, now);
      if (w.expiresAt !== null && w.expiresAt <= now) {
        await deps.stop(w.agentGroupId, w.name, 'expired');
        await deps.notify(
          w.agentGroupId,
          `[System] Your workload "${w.name}" passed its expiry date and was stopped. Tell the people here: an admin of this agent can extend it in Agent → Apps and start it again. Or ask with \`ncl workloads extend --name ${w.name}\` (an approval card), or remove it with \`ncl workloads delete --name ${w.name}\`.`,
        );
        continue;
      }
      if (w.expiresAt !== null && w.expiresAt - now <= EXPIRY_NOTICE_MS && w.expiryNoticeFor !== w.expiresAt) {
        // Once per expiry: recorded first, so a failed notice is not repeated every two minutes.
        await updateWorkload(w.id, { expiryNoticeFor: w.expiresAt });
        await deps.notify(
          w.agentGroupId,
          `[System] Your workload "${w.name}" expires on ${dayText(w.expiresAt)} and stops then. Tell the people here: an admin of this agent can extend it in Agent → Apps. You can also ask with \`ncl workloads extend --name ${w.name}\` (an approval card).`,
        );
      }
      if (!parsePs(await deps.ps(w)).length)
        await updateWorkload(w.id, { state: 'failed', lastError: 'its containers are gone' });
    } catch (err) {
      log.warn('Workload reconcile failed', { workloadId: w.id, err: String(err).slice(0, 200) });
    }
  }
}

/**
 * Near its expiry (when the reminder would go out), a workload whose
 * published app was opened in the last week is kept for DEFAULT_DAYS more,
 * as an Extend would. Unpublished or unused ones are left to the reminder.
 */
export async function renewIfUsed(w: Workload, now = Date.now()): Promise<Workload> {
  if (w.expiresAt === null || w.expiresAt - now > EXPIRY_NOTICE_MS) return w;
  const opened = await lastOpened(w.id);
  if (opened === null || now - opened > USED_WITHIN_MS) return w;
  return extendWorkload(w.agentGroupId, w.name, 'system:renew-while-used', now);
}

/**
 * A deploy cut off by a NanoClaw restart stays 'deploying' for good: nothing
 * finishes it. It is never re-run on its own; it is recorded as it is —
 * running when every service's previous container still runs, else failed —
 * and the agent is told what to do. (A restore never goes through a deploy:
 * restoreWorkload stops, restores and starts, so this is never a half-restore.)
 */
export async function settleInterrupted(
  deps: {
    list?: typeof listWorkloads;
    /** The stack's containers: service and state. */
    states?: (w: Workload) => Promise<Array<{ service: string; state: string }>>;
    update?: typeof updateWorkload;
    tell?: (agentGroupId: string, text: string) => Promise<unknown>;
    linked?: (node: string) => boolean;
    /** Whether the stack file was ever written: a first deploy cut off while building has none. */
    written?: (w: Workload) => boolean;
    now?: number;
  } = {},
): Promise<void> {
  const now = deps.now ?? Date.now();
  const list = deps.list ?? listWorkloads;
  const update = deps.update ?? updateWorkload;
  const tell = deps.tell ?? notifyWorkloadAgent;
  const linked = deps.linked ?? ((n: string) => n === LOCAL_NODE || isLinked(n));
  const written = deps.written ?? ((w: Workload) => fs.existsSync(path.join(workDir(w.id), 'stack.yml')));
  const states =
    deps.states ??
    (async (w: Workload) =>
      parsePs(await compose(w, ['ps', '--all', '--format', 'json'], 60_000)).map((c) => ({
        service: String(c.Service ?? ''),
        state: String(c.State ?? ''),
      })));
  for (const w of await list()) {
    // A minute's grace: a new stack is recorded 'deploying' a moment before its deploy starts.
    if (w.state !== 'deploying' || deployInFlight(w.id) || now - w.updatedAt < 60_000 || !linked(w.node)) continue;
    try {
      // Running only when every service has a running container: half a stack is a failed one.
      // No stack file: nothing of it was ever started, and `compose ps` could not even be asked.
      const seen = written(w) ? await states(w) : [];
      const running = new Set(seen.filter((c) => c.state === 'running').map((c) => c.service));
      const up = Object.keys(w.stack.compose.services).every((s) => running.has(s));
      const why = 'its last deploy was cut off by a NanoClaw restart';
      await update(w.id, {
        state: up ? 'running' : 'failed',
        lastError: up ? `${why}; the previous version is still running` : why,
      });
      log.info('Workload deploy interrupted', { workloadId: w.id, name: w.name, running: up });
      await tell(
        w.agentGroupId,
        `[System] The deploy of your workload "${w.name}" was cut off by a NanoClaw restart. ${
          up ? 'The previous version is still running.' : 'It is not running.'
        } Run \`ncl workloads redeploy --name ${w.name}\` with the same file to finish it.`,
      );
    } catch (err) {
      log.warn('Workload reconcile failed', { workloadId: w.id, err: String(err).slice(0, 200) });
    }
  }
}

export function __resetWorkloadReconcileForTest(): void {
  last = -Infinity;
  lastDisk = -Infinity;
  backingUp = false;
  told.clear();
}
