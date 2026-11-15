/**
 * Connections the egress filter refused to an agent's workload builds, kept
 * briefly, so a failed build can say what was blocked and why
 * (workloads/docker.ts compose): BuildKit itself shows only "Forbidden" or
 * "Bad Gateway", whatever the reason was.
 */
const KEEP_MS = 2 * 3600_000;
const MAX_PER_AGENT = 50;

interface Refusal {
  at: number;
  host: string;
  port: number;
  reason: string;
}

const byAgent = new Map<string, Refusal[]>();

export function noteBuildRefusal(
  agentGroupId: string,
  host: string,
  port: number,
  reason: string,
  now = Date.now(),
): void {
  const list = (byAgent.get(agentGroupId) ?? []).filter((r) => now - r.at < KEEP_MS);
  list.push({ at: now, host: host.toLowerCase(), port, reason: reason.slice(0, 300) });
  byAgent.set(agentGroupId, list.slice(-MAX_PER_AGENT));
}

/** One line per refused host:port since `since` (its latest reason), oldest first. */
export function buildRefusalsSince(agentGroupId: string, since: number): string[] {
  const seen = new Map<string, string>();
  for (const r of byAgent.get(agentGroupId) ?? []) if (r.at >= since) seen.set(`${r.host}:${r.port}`, r.reason);
  return [...seen].map(([hp, reason]) => `${hp}: ${reason}`);
}

export function __resetBuildRefusalsForTest(): void {
  byAgent.clear();
}
