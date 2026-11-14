/**
 * Where a new workload runs. This decides and says why in one line, shown on
 * the approval card:
 *
 *   1. candidates: worker machines an owner turned "Run workloads here" on
 *      for (Admin → Machines; off for every machine that joins), that
 *      report, are linked, are neither draining nor revoked, AND passed
 *      their workload isolation check recently (members.ts isolationStatus).
 *      Central while no such worker exists or none has room (central's own
 *      ceiling still applies), and the reason says why.
 *   2. fit: the stack's memory within the worker's free share (NanoClaw's
 *      share of the machine — totals minus other software's peak minus 15%
 *      headroom, members.ts availableOn — minus what is placed there already)
 *   3. together: an agent's stacks go where its other stacks run
 *   4. an owner's pin wins over the switch (also on a draining machine: drain
 *      it and pin one agent to it, and only that agent's stacks go there),
 *      but never over a failed or missing isolation check: then it refuses
 *   5. most free memory, then CPU
 *
 * A workload stays where it was placed (its volumes live there). CPU is
 * capped by the worker's slice rather than counted as a hard fit: a share of
 * a fraction of a CPU would otherwise refuse every stack. Builds and image
 * pulls run on central and the images are sent (control.ts), so any worker
 * takes any stack; no new stack goes to a worker with less than
 * MIN_DISK_FREE_GB free.
 */
import { availableOn, isHealthy, isolationRefusal, listMembers, type Member } from '../machines/members.js';
import { isLinked } from '../machines/links.js';
import { listWorkloads, pinFor, type Workload } from './store.js';

export const LOCAL = 'local';
/** A worker with less free disk than this takes no new stacks. */
export const MIN_DISK_FREE_GB = 3;

export interface Placement {
  node: string;
  reason: string;
}

export interface PlaceDeps {
  members: () => Promise<Member[]>;
  linked: (id: string) => boolean;
  workloads: () => Promise<Workload[]>;
  pin: (agentGroupId: string) => Promise<string | null>;
  now?: number;
}

const defaultDeps = (): PlaceDeps => ({
  members: listMembers,
  linked: isLinked,
  workloads: () => listWorkloads(),
  pin: pinFor,
});

export interface Room {
  machine: Member;
  freeMemMb: number;
  freeCpus: number;
}

/**
 * What is left of each usable worker's share once the workloads placed on it
 * are counted. Usable: a ready (or, with `draining`, draining) worker that
 * reports, is linked and passed its isolation check recently. `optedIn`
 * keeps only workers an owner turned workloads on for.
 */
export async function workerRooms(
  deps: PlaceDeps = defaultDeps(),
  exceptId?: string,
  opts: { draining?: boolean; optedIn?: boolean } = {},
): Promise<Room[]> {
  const now = deps.now ?? Date.now();
  const placed = (await deps.workloads()).filter((w) => w.state !== 'deleted' && w.id !== exceptId);
  const usable = (m: Member): boolean => m.state === 'ready' || (opts.draining === true && m.state === 'draining');
  return (await deps.members())
    .filter(
      (m) =>
        m.role === 'worker' &&
        usable(m) &&
        isHealthy(m, now) &&
        deps.linked(m.id) &&
        isolationRefusal(m, now) === null &&
        (opts.optedIn !== true || m.workloadsOn),
    )
    .map((m) => {
      const here = placed.filter((w) => w.node === m.id);
      const share = availableOn(m);
      return {
        machine: m,
        freeMemMb: share.memMb - here.reduce((a, w) => a + w.approvedMemoryMb, 0),
        freeCpus: share.cpus - here.reduce((a, w) => a + w.approvedCpus, 0),
      };
    });
}

const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;

export async function placeWorkload(
  agentGroupId: string,
  need: { memoryMb: number; cpus: number },
  deps: PlaceDeps = defaultDeps(),
): Promise<Placement> {
  const now = deps.now ?? Date.now();
  const pin = await deps.pin(agentGroupId);
  if (pin === LOCAL) return { node: LOCAL, reason: 'pinned to central by an owner' };
  if (pin) {
    // A pin outranks "Run workloads here" (off or on), never the isolation check.
    const m = (await deps.members()).find((x) => x.id === pin && x.role === 'worker');
    const refused = m && isHealthy(m, now) && deps.linked(m.id) ? isolationRefusal(m, now) : null;
    if (refused) throw new Error(`this agent's workloads are pinned to ${m!.name}, and ${refused}; ask an owner`);
    // A pin reaches a draining machine too: drain one and pin an agent to it, and only that agent's stacks go there.
    const r = (await workerRooms(deps, undefined, { draining: true })).find((x) => x.machine.id === pin);
    if (!r)
      throw new Error(`this agent's workloads are pinned to a worker that is not available (${pin}); ask an owner`);
    if (r.freeMemMb < need.memoryMb)
      throw new Error(
        `the pinned worker ${r.machine.name} has ${gb(Math.max(0, r.freeMemMb))} free, and this needs ${gb(need.memoryMb)}; ask an owner`,
      );
    return { node: r.machine.id, reason: `pinned to ${r.machine.name} by an owner` };
  }
  const rooms = await workerRooms(deps, undefined, { optedIn: true });
  if (!rooms.length) {
    // Say so when a worker exists but is not usable now: the stack lands on central instead.
    const workers = (await deps.members()).filter((m) => m.role === 'worker' && m.state !== 'revoked');
    const optedIn = workers.filter((m) => m.workloadsOn);
    if (workers.length && !optedIn.length)
      return {
        node: LOCAL,
        reason: 'no worker runs workloads (an owner turns that on per machine in Admin → Machines)',
      };
    const down = optedIn
      .map((m) =>
        m.state === 'draining'
          ? `${m.name} draining`
          : !isHealthy(m, now)
            ? `${m.name} not reporting`
            : !deps.linked(m.id)
              ? `${m.name} not linked`
              : isolationRefusal(m, now),
      )
      .filter((x): x is string => !!x);
    return { node: LOCAL, reason: down.length ? `no worker usable: ${down.join('; ')}` : 'no worker connected' };
  }
  // Keep some of the worker's own disk free: images land there.
  // No worker with room: central takes it, within its own ceiling (control.ts
  // checkWorkload refuses there if central is full too).
  const roomy = rooms.filter((r) => (r.machine.health?.diskFreeGb ?? MIN_DISK_FREE_GB) >= MIN_DISK_FREE_GB);
  if (!roomy.length) return { node: LOCAL, reason: `no worker has ${MIN_DISK_FREE_GB} GB of disk free` };
  const fits = roomy.filter((r) => r.freeMemMb >= need.memoryMb);
  if (!fits.length) {
    const best = [...roomy].sort((a, b) => b.freeMemMb - a.freeMemMb)[0];
    return {
      node: LOCAL,
      reason: `no worker has room for ${gb(need.memoryMb)} (most free: ${gb(Math.max(0, best.freeMemMb))} on ${best.machine.name})`,
    };
  }
  const mine = new Set(
    (await deps.workloads())
      .filter((w) => w.agentGroupId === agentGroupId && w.state !== 'deleted' && w.node !== LOCAL)
      .map((w) => w.node),
  );
  const together = fits.find((r) => mine.has(r.machine.id));
  if (together)
    return {
      node: together.machine.id,
      reason: `${together.machine.name} (runs workloads, turned on by an owner): with this agent's other stacks; fits ${gb(need.memoryMb)} with 15% spare`,
    };
  const best = [...fits].sort((a, b) => b.freeMemMb - a.freeMemMb || b.freeCpus - a.freeCpus)[0];
  return {
    node: best.machine.id,
    reason: `${best.machine.name} (runs workloads, turned on by an owner): most free memory; fits ${gb(need.memoryMb)} with 15% spare`,
  };
}
