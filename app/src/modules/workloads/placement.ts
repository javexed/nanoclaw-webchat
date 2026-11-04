/**
 * Where a new workload runs (Scaling design: placement). Nobody chooses; this
 * decides and says why in one line:
 *
 *   1. candidates: worker machines that report, are linked, and are neither
 *      draining nor revoked; central only while no such worker exists
 *   2. fit: the stack's memory within the worker's free share (NanoClaw's
 *      share of the machine — totals minus other software's peak minus 15%
 *      headroom, members.ts availableOn — minus what is placed there already)
 *   3. together: an agent's stacks go where its other stacks run
 *   4. an owner's pin wins (also on a draining machine: drain it and pin
 *      one agent to it, and only that agent's stacks go there)
 *   5. most free memory, then CPU
 *
 * A workload stays where it was placed (its volumes live there). CPU is
 * capped by the worker's slice rather than counted as a hard fit: a share of
 * a fraction of a CPU would otherwise refuse every stack. Builds and image
 * pulls run on central and the images are sent (control.ts), so any worker
 * takes any stack; no new stack goes to a worker with less than
 * MIN_DISK_FREE_GB free.
 */
import { availableOn, isHealthy, listMembers, type Member } from '../machines/members.js';
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

/** What is left of each usable worker's share once the workloads placed on it are counted. */
export async function workerRooms(
  deps: PlaceDeps = defaultDeps(),
  exceptId?: string,
  opts: { draining?: boolean } = {},
): Promise<Room[]> {
  const now = deps.now ?? Date.now();
  const placed = (await deps.workloads()).filter((w) => w.state !== 'deleted' && w.id !== exceptId);
  const usable = (m: Member): boolean => m.state === 'ready' || (opts.draining === true && m.state === 'draining');
  return (await deps.members())
    .filter((m) => m.role === 'worker' && usable(m) && isHealthy(m, now) && deps.linked(m.id))
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
  const pin = await deps.pin(agentGroupId);
  if (pin === LOCAL) return { node: LOCAL, reason: 'pinned to central by an owner' };
  const rooms = await workerRooms(deps);
  if (pin) {
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
  if (!rooms.length) {
    // Say so when a worker exists but is not usable now: the stack lands on central instead.
    const now = deps.now ?? Date.now();
    const down = (await deps.members())
      .filter((m) => m.role === 'worker' && m.state !== 'revoked')
      .map((m) =>
        m.state === 'draining'
          ? `${m.name} draining`
          : !isHealthy(m, now)
            ? `${m.name} not reporting`
            : !deps.linked(m.id)
              ? `${m.name} not linked`
              : null,
      )
      .filter((x): x is string => !!x);
    return { node: LOCAL, reason: down.length ? `no worker usable (${down.join(', ')})` : 'no worker connected' };
  }
  // Keep some of the worker's own disk free: images land there.
  const roomy = rooms.filter((r) => (r.machine.health?.diskFreeGb ?? MIN_DISK_FREE_GB) >= MIN_DISK_FREE_GB);
  if (!roomy.length)
    throw new Error(`every worker has less than ${MIN_DISK_FREE_GB} GB of disk free; an owner can add a machine`);
  const fits = roomy.filter((r) => r.freeMemMb >= need.memoryMb);
  if (!fits.length) {
    const best = [...roomy].sort((a, b) => b.freeMemMb - a.freeMemMb)[0];
    throw new Error(
      `no worker has room for ${gb(need.memoryMb)} (most free: ${gb(Math.max(0, best.freeMemMb))} on ${best.machine.name}); an owner can add a machine`,
    );
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
      reason: `${together.machine.name}: with this agent's other stacks; fits ${gb(need.memoryMb)} with 15% spare`,
    };
  const best = [...fits].sort((a, b) => b.freeMemMb - a.freeMemMb || b.freeCpus - a.freeCpus)[0];
  return {
    node: best.machine.id,
    reason: `${best.machine.name}: most free memory; fits ${gb(need.memoryMb)} with 15% spare`,
  };
}
