/**
 * Central's half of a worker's workload isolation check. The worker runs the
 * check itself (worker-main.ts: at start, every half hour, and when asked)
 * and reports the result with its health; placement uses a worker only while
 * that result is a recent pass (members.ts isolationStatus).
 *
 * Here: send the worker the helper image the check runs in and ask for a
 * check when it links, and again while its result is missing or old; and
 * when a worker reports that the check got through, record its stacks as
 * stopped (the worker stopped them itself) and tell their agents.
 */
import { audit } from '../../audit.js';
import { log } from '../../log.js';
import { callWorker, isLinked } from '../machines/links.js';
import { isolationStatus, listMembers, type Member } from '../machines/members.js';
import { helperOn } from './backup.js';
import { notifyWorkloadAgent } from './notify.js';
import { listWorkloads, updateWorkload, type Workload } from './store.js';

/** Ask a worker whose result is missing or old again at most this often. */
export const ASK_EVERY_MS = 10 * 60_000;
export const STOPPED_OPEN =
  'stopped on its worker: a workload there could reach the machine itself (host rules missing)';

/** Send the helper image and run the check on the worker now; its answer also arrives with the next health report. */
export async function askWorkerProbe(machineId: string): Promise<string> {
  const image = await helperOn(machineId);
  const r = (await callWorker(machineId, 'probe', { image }, 120_000)) as { isolation?: string; detail?: string };
  return String(r?.isolation ?? 'unknown');
}

export interface WorkerIsolationDeps {
  members: () => Promise<Member[]>;
  linked: (id: string) => boolean;
  ask: (id: string) => Promise<unknown>;
  workloads: () => Promise<Workload[]>;
  stopped: (w: Workload) => Promise<unknown>;
  notify: typeof notifyWorkloadAgent;
}

const defaults: WorkerIsolationDeps = {
  members: listMembers,
  linked: isLinked,
  ask: askWorkerProbe,
  workloads: () => listWorkloads(),
  stopped: (w) => updateWorkload(w.id, { state: 'stopped', lastError: STOPPED_OPEN }),
  notify: notifyWorkloadAgent,
};

const asked = new Map<string, number>();

export async function reconcileWorkerIsolation(now = Date.now(), deps: WorkerIsolationDeps = defaults): Promise<void> {
  const workers = (await deps.members()).filter((m) => m.role === 'worker' && m.state !== 'revoked');
  for (const m of workers) {
    const status = isolationStatus(m, now);
    if ((status === 'unknown' || status === 'stale') && deps.linked(m.id)) {
      if (now - (asked.get(m.id) ?? -Infinity) >= ASK_EVERY_MS) {
        asked.set(m.id, now);
        await deps.ask(m.id).catch((err) =>
          log.warn('Worker isolation check could not be asked for', {
            machineId: m.id,
            err: String(err).slice(0, 300),
          }),
        );
      }
    }
    if (status !== 'open') continue;
    // The worker stopped these itself when its check got through; the record says so.
    for (const w of (await deps.workloads()).filter(
      (x) => x.node === m.id && (x.state === 'running' || x.state === 'deploying'),
    )) {
      await deps.stopped(w);
      audit({
        type: 'workload.autostop',
        actor: 'system',
        effect: 'allow',
        reason: 'worker isolation',
        detail: { workload: w.id, node: m.id },
      });
      log.error('Workload stopped: its worker failed the isolation check', { workloadId: w.id, machineId: m.id });
      await deps
        .notify(
          w.agentGroupId,
          `[System] Your workload "${w.name}" was stopped: its worker ${m.name} failed the isolation check (a workload there could reach the machine itself). An owner has to fix that machine; then \`ncl workloads start --name ${w.name}\`.`,
        )
        .catch(() => undefined);
    }
  }
}

export function __resetWorkerIsolationForTest(): void {
  asked.clear();
}
