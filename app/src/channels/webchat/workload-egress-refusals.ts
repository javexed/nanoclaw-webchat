/**
 * Connections a running workload stack was refused at runtime
 * (workload-egress.ts), kept briefly in memory per agent, so `ncl workloads
 * status` and Agent → Apps can say what a service tried to reach and why:
 * the service itself usually sees only "Forbidden".
 */
const KEEP_MS = 24 * 3600_000;
const MAX_PER_AGENT = 100;

export interface WorkloadEgressRefusal {
  at: number;
  /** The workload and service that asked; null when the caller was not a known service. */
  workloadId: string | null;
  service: string | null;
  host: string;
  port: number;
  reason: string;
}

const byAgent = new Map<string, WorkloadEgressRefusal[]>();

export function noteWorkloadEgressRefusal(
  agentGroupId: string,
  workloadId: string | null,
  service: string | null,
  host: string,
  port: number,
  reason: string,
  now = Date.now(),
): void {
  const list = (byAgent.get(agentGroupId) ?? []).filter((r) => now - r.at < KEEP_MS);
  list.push({ at: now, workloadId, service, host: host.toLowerCase(), port, reason: reason.slice(0, 300) });
  byAgent.set(agentGroupId, list.slice(-MAX_PER_AGENT));
}

/** This agent's recent refusals, newest first; only one workload's when `workloadId` is given. */
export function workloadEgressRefusals(
  agentGroupId: string,
  workloadId?: string,
  now = Date.now(),
): WorkloadEgressRefusal[] {
  return (byAgent.get(agentGroupId) ?? [])
    .filter((r) => now - r.at < KEEP_MS && (workloadId === undefined || r.workloadId === workloadId))
    .reverse();
}

export function __resetWorkloadEgressRefusalsForTest(): void {
  byAgent.clear();
}
