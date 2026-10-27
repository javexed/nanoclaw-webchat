/**
 * Keeps workloads honest, from the module sweep:
 *
 *   - the preflight (preflight.ts) at the first sweep and every half hour;
 *     when it finds the host reachable from a workload network, every running
 *     stack is stopped until the host rules are back;
 *   - agents stay joined to their own networks (a new agent container starts
 *     without them; watch.ts joins most of them at start already);
 *   - every two minutes: a running stack whose containers have gone is
 *     recorded as failed, and expired stacks are stopped and their agent told;
 *   - every ten minutes disk use is measured against each agent's quota
 *     (disk.ts);
 *   - once a night each stack's volumes are backed up (backup.ts), and the
 *     backups of a workload deleted a week ago are removed.
 */
import fs from 'fs';

import { log } from '../../log.js';
import { backupRoot, backupWorkload, listBackups, removeBackups, stampTime } from './backup.js';
import { parsePs, serviceImages, stopWorkload } from './control.js';
import { diskLevel, gb, measureDisk, recordUsage, type DiskLevel } from './disk.js';
import { compose, joinAgentContainers } from './docker.js';
import { notifyWorkloadAgent } from './notify.js';
import { preflightDue, runPreflight, type PreflightResult } from './preflight.js';
import { allNetworks, listWorkloads, quotaFor, updateWorkload, type Workload } from './store.js';

const EVERY_MS = 2 * 60_000;
const DISK_EVERY_MS = 10 * 60_000;
const BACKUP_AGE_MS = 20 * 3_600_000;
const KEEP_DELETED_MS = 7 * 86_400_000;
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
}

const defaults: ReconcileDeps = {
  preflight: () => runPreflight(),
  stop: stopWorkload,
  notify: notifyWorkloadAgent,
  ps: (w) => compose(w, ['ps', '--all', '--format', 'json'], 60_000),
  join: joinAgentContainers,
  measure: measureDisk,
  backup: backupWorkload,
};

/** Stop every running stack: the host is reachable from workload networks. */
async function stopAllRunning(deps: ReconcileDeps): Promise<void> {
  for (const w of (await listWorkloads()).filter((x) => x.state === 'running' || x.state === 'deploying')) {
    await deps
      .stop(w.agentGroupId, w.name, 'host isolation missing')
      .catch((err) => log.error('Workload could not be stopped', { workloadId: w.id, err: String(err).slice(0, 200) }));
  }
}

async function checkDisk(deps: ReconcileDeps): Promise<void> {
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
  for (const w of all.filter((x) => x.state === 'running' || x.state === 'stopped')) {
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
  // Every sweep: cheap, and a freshly started agent container cannot reach its own stacks until it has joined.
  for (const n of await allNetworks()) {
    await deps
      .join(n.agentGroupId, n.network)
      .catch((err) =>
        log.warn('Workload network join failed', { agentGroupId: n.agentGroupId, err: String(err).slice(0, 200) }),
      );
  }
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
  for (const w of await listWorkloads()) {
    if (w.state !== 'running') continue;
    try {
      if (w.expiresAt !== null && w.expiresAt <= now) {
        await deps.stop(w.agentGroupId, w.name, 'expired');
        await deps.notify(
          w.agentGroupId,
          `[System] Your workload "${w.name}" passed its expiry date and was stopped. Ask an owner to extend it, or remove it with \`ncl workloads delete --name ${w.name}\`.`,
        );
        continue;
      }
      if (!parsePs(await deps.ps(w)).length)
        await updateWorkload(w.id, { state: 'failed', lastError: 'its containers are gone' });
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
