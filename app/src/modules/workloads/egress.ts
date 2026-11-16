/**
 * Runtime egress for this host's stacks (x-nanoclaw-egress). The proxy and
 * its rules live in channels/webchat/workload-egress.ts; this decides which
 * agent networks get a listener, knows who is calling on one, and holds a
 * declaration to the install's switch and the agent's own reach.
 *
 * Off until an owner sets NANOCLAW_WORKLOAD_EGRESS_PORT (and adds the port to
 * the host rules): a stack that declares egress is refused until then.
 * Central only: a stack on a worker has no proxy to reach (placement.ts
 * keeps such stacks here).
 */
import {
  closeWorkloadEgressListener,
  dockerSubnets,
  openWorkloadEgressListener,
  workloadEgressCovered,
  workloadEgressListeners,
  workloadSessionId,
  type WorkloadEgressCaller,
  type WorkloadEgressDeps,
} from '../../channels/webchat/workload-egress.js';
import { allowlistFor, groupEgressMode, ownModelTargetsFor } from '../../channels/webchat/egress-policy.js';
import { log } from '../../log.js';
import { LOCAL_NODE } from './docker.js';
import { subnetFor, type OverrideInput } from './override.js';
import { declaredEgress, type CheckedStack } from './policy.js';
import { approvedEgress, decodeApproved } from './shape.js';
import { egressRefusal } from './preflight.js';
import { workloadEgressPort } from './settings.js';
import { allNetworks, listWorkloads, type Workload } from './store.js';
import { edgeSettings } from './tailnet/config.js';

export const EGRESS_OFF =
  'runtime egress is off on this host (x-nanoclaw-egress): an owner turns on runtime egress (NANOCLAW_WORKLOAD_EGRESS_PORT and the host rules’ --stack-egress-port); or remove x-nanoclaw-egress';

/** The egress port, or throws why a stack that declares egress cannot run here now. */
export function requireWorkloadEgress(): number {
  const port = workloadEgressPort();
  if (port === null) throw new Error(EGRESS_OFF);
  // The preflight's check of the port (preflight.ts): let through, and held by nothing else here.
  const refused = egressRefusal(port);
  if (refused) throw new Error(refused);
  return port;
}

/** What the owner approved each service of this workload to call (services with none left out). */
export const egressOf = (w: Pick<Workload, 'approvedShape'>): Record<string, string[]> =>
  approvedEgress(decodeApproved(w.approvedShape));

/** Ranges no entry may name, besides the fixed ones: the publishing edge subnet. */
export function egressDeny(): string[] {
  const e = edgeSettings();
  return e.ok ? [e.cfg.subnet] : [];
}

/**
 * Hold a checked stack's declarations to the agent's own reach: every entry
 * within its allowlist or its own model (never the model floor). Open agents
 * have no allowlist to be within. Throws with each entry that is not.
 */
export async function checkEgressSubset(agentGroupId: string, stack: Pick<CheckedStack, 'compose'>): Promise<void> {
  const declared = declaredEgress(stack);
  if (!Object.keys(declared).length) return;
  const mode = await groupEgressMode(agentGroupId);
  const allowlist = mode === 'host-only' ? await allowlistFor(agentGroupId) : [];
  const own = await ownModelTargetsFor(agentGroupId);
  const outside: string[] = [];
  for (const [svc, entries] of Object.entries(declared))
    for (const e of entries)
      if (!workloadEgressCovered(e, mode, allowlist, own)) outside.push(`${svc}: x-nanoclaw-egress ${e}`);
  if (outside.length)
    throw new Error(
      `the stack was refused:\n- ${outside.join('\n- ')} — a stack may call only what you may reach yourself${
        mode === 'none' ? ' (you are on Model only: your own model)' : ''
      }; an admin can add a host to your Network list`,
    );
}

/** The override's egress settings for a workload's approved services, or undefined when it has none. */
export function overrideEgress(w: Pick<Workload, 'approvedShape'>, idx: number): OverrideInput['egress'] {
  const services = Object.keys(egressOf(w));
  const port = workloadEgressPort();
  if (!services.length || port === null) return undefined;
  const { gateway, subnet } = subnetFor(idx);
  return { gateway, port, subnet, services };
}

/** Whether this workload keeps its network's listener open: on central, approved egress, and running (or asleep, to wake). */
const wantsListener = (w: Workload): boolean =>
  w.node === LOCAL_NODE &&
  Object.keys(egressOf(w)).length > 0 &&
  (w.state === 'running' || w.state === 'deploying' || (w.state === 'stopped' && w.asleepAt !== null));

/**
 * Who is calling on a listener: `local` is an agent network's gateway, and
 * the caller must hold a service address of a running stack of that agent.
 * Anything else on the network (the agent's own containers, a stray
 * address) is known only as the agent's, with nothing approved.
 */
export async function identifyWorkloadCaller(local: string, remote: string): Promise<WorkloadEgressCaller | null> {
  const n = (await allNetworks()).find((x) => subnetFor(x.idx).gateway === local);
  if (!n) return null;
  for (const w of await listWorkloads({ agentGroupId: n.agentGroupId })) {
    if (w.node !== LOCAL_NODE || w.state !== 'running') continue;
    for (const [svc, addr] of Object.entries(w.addresses)) {
      if (addr !== remote) continue;
      return {
        agentGroupId: w.agentGroupId,
        sessionId: workloadSessionId(w.id, svc),
        workloadId: w.id,
        service: svc,
        // The approved record, never the agent's files.
        approved: egressOf(w)[svc] ?? [],
      };
    }
  }
  return { agentGroupId: n.agentGroupId, sessionId: 'workload:unknown', workloadId: null, service: null, approved: [] };
}

const deps: WorkloadEgressDeps = {
  identify: identifyWorkloadCaller,
  forbidden: async () => [...(await dockerSubnets()), ...egressDeny()],
};

/** Open the listener on an agent's network (a deploy, before its containers start). Throws when it cannot listen. */
export async function openAgentEgress(idx: number, port: number): Promise<void> {
  const { gateway } = subnetFor(idx);
  await openWorkloadEgressListener(gateway, port, deps).catch((err: unknown) => {
    throw new Error(
      `runtime egress could not listen on ${gateway}:${port}: ${String((err as Error).message ?? err).slice(0, 200)}`,
      { cause: err },
    );
  });
}

/**
 * Bring the listeners in line with what runs: one on each agent network
 * whose agent runs a stack here with approved egress (and only on the
 * configured port), none elsewhere. `agentGroupId` limits it to one agent.
 */
export async function syncWorkloadEgress(agentGroupId?: string): Promise<void> {
  const set = workloadEgressPort();
  // A port the preflight refused (a host service holds it, the rule is missing) gets no listener.
  const port = set !== null && egressRefusal(set) === null ? set : null;
  const nets = await allNetworks();
  const gateways = new Set(nets.map((n) => subnetFor(n.idx).gateway));
  // Stale first: a port that changed, a network that is gone, or the feature switched off.
  for (const k of workloadEgressListeners()) {
    const i = k.lastIndexOf(':');
    const gw = k.slice(0, i);
    if (port === null || Number(k.slice(i + 1)) !== port || !gateways.has(gw)) closeWorkloadEgressListener(gw);
  }
  const workloads = await listWorkloads(agentGroupId ? { agentGroupId } : {});
  for (const n of nets) {
    if (agentGroupId && n.agentGroupId !== agentGroupId) continue;
    const { gateway } = subnetFor(n.idx);
    const want = port !== null && workloads.some((w) => w.agentGroupId === n.agentGroupId && wantsListener(w));
    if (!want) closeWorkloadEgressListener(gateway);
    else
      await openWorkloadEgressListener(gateway, port, deps).catch((err: unknown) =>
        log.warn('Workload egress: could not listen', { gateway, port, err: String(err).slice(0, 200) }),
      );
  }
}
