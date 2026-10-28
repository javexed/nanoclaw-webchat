// Workload, network, quota, build and registry rows. Mapping only: the rules live in control.ts.
import { randomUUID } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import type { CheckedStack, Quota } from './policy.js';

export type WorkloadState = 'deploying' | 'running' | 'stopped' | 'failed' | 'deleted';

export interface Workload {
  id: string;
  agentGroupId: string;
  name: string;
  node: string;
  state: WorkloadState;
  composeText: string;
  stack: CheckedStack;
  addresses: Record<string, string>;
  memoryMb: number;
  cpus: number;
  /** The size an owner approved; a redeploy within it needs no new card. */
  approvedMemoryMb: number;
  approvedCpus: number;
  /** What an owner approved (shape.ts encodeApproved); null before one was recorded. */
  approvedShape: string | null;
  lastError: string | null;
  expiresAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  agent_group_id: string;
  name: string;
  node: string;
  state: WorkloadState;
  compose_text: string;
  stack_json: string;
  addresses_json: string;
  memory_mb: number;
  cpus: number;
  approved_memory_mb: number;
  approved_cpus: number;
  approved_shape?: string | null;
  last_error: string | null;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const toWorkload = (r: Row): Workload => ({
  id: r.id,
  agentGroupId: r.agent_group_id,
  name: r.name,
  node: r.node,
  state: r.state,
  composeText: r.compose_text,
  stack: JSON.parse(r.stack_json) as CheckedStack,
  addresses: JSON.parse(r.addresses_json) as Record<string, string>,
  memoryMb: r.memory_mb,
  cpus: r.cpus,
  approvedMemoryMb: r.approved_memory_mb,
  approvedCpus: r.approved_cpus,
  approvedShape: r.approved_shape ?? null,
  lastError: r.last_error,
  expiresAt: r.expires_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const workloadsReady = async (): Promise<boolean> => hasTable(getDb(), 'workloads');

export async function listWorkloads(
  filter: { agentGroupId?: string; includeDeleted?: boolean } = {},
): Promise<Workload[]> {
  if (!(await workloadsReady())) return [];
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.agentGroupId) {
    where.push('agent_group_id = ?');
    args.push(filter.agentGroupId);
  }
  if (!filter.includeDeleted) where.push(`state <> 'deleted'`);
  const sql = `SELECT * FROM workloads${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`;
  return ((await getDb().all(sql, ...args)) as Row[]).map(toWorkload);
}

export async function findWorkload(agentGroupId: string, name: string): Promise<Workload | null> {
  const r = (await getDb().get(
    `SELECT * FROM workloads WHERE agent_group_id = ? AND name = ? AND state <> 'deleted'`,
    agentGroupId,
    name,
  )) as Row | undefined;
  return r ? toWorkload(r) : null;
}

export async function getWorkload(id: string): Promise<Workload | null> {
  const r = (await getDb().get(`SELECT * FROM workloads WHERE id = ?`, id)) as Row | undefined;
  return r ? toWorkload(r) : null;
}

export async function insertWorkload(
  w: Pick<
    Workload,
    'agentGroupId' | 'name' | 'composeText' | 'stack' | 'addresses' | 'expiresAt' | 'createdBy' | 'approvedShape'
  >,
  now = Date.now(),
): Promise<Workload> {
  const id = randomUUID();
  await getDb().run(
    `INSERT INTO workloads (id, agent_group_id, name, node, state, compose_text, stack_json, addresses_json, memory_mb, cpus,
       approved_memory_mb, approved_cpus, approved_shape, expires_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'local', 'deploying', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    w.agentGroupId,
    w.name,
    w.composeText,
    JSON.stringify(w.stack),
    JSON.stringify(w.addresses),
    w.stack.total.memoryMb,
    w.stack.total.cpus,
    w.stack.total.memoryMb,
    w.stack.total.cpus,
    w.approvedShape,
    w.expiresAt,
    w.createdBy,
    now,
    now,
  );
  return (await getWorkload(id))!;
}

export async function updateWorkload(
  id: string,
  patch: Partial<
    Pick<
      Workload,
      | 'state'
      | 'composeText'
      | 'stack'
      | 'addresses'
      | 'lastError'
      | 'expiresAt'
      | 'approvedMemoryMb'
      | 'approvedCpus'
      | 'approvedShape'
    >
  >,
  now = Date.now(),
): Promise<Workload> {
  const sets: string[] = [];
  const args: unknown[] = [];
  const put = (col: string, v: unknown): void => {
    sets.push(`${col} = ?`);
    args.push(v ?? null);
  };
  if (patch.state !== undefined) put('state', patch.state);
  if (patch.composeText !== undefined) put('compose_text', patch.composeText);
  if (patch.stack !== undefined) {
    put('stack_json', JSON.stringify(patch.stack));
    put('memory_mb', patch.stack.total.memoryMb);
    put('cpus', patch.stack.total.cpus);
  }
  if (patch.addresses !== undefined) put('addresses_json', JSON.stringify(patch.addresses));
  if ('lastError' in patch) put('last_error', patch.lastError);
  if ('expiresAt' in patch) put('expires_at', patch.expiresAt);
  if (patch.approvedMemoryMb !== undefined) put('approved_memory_mb', patch.approvedMemoryMb);
  if (patch.approvedCpus !== undefined) put('approved_cpus', patch.approvedCpus);
  if (patch.approvedShape !== undefined) put('approved_shape', patch.approvedShape);
  put('updated_at', now);
  args.push(id);
  await getDb().run(`UPDATE workloads SET ${sets.join(', ')} WHERE id = ?`, ...args);
  return (await getWorkload(id))!;
}

// ── networks ──────────────────────────────────────────────────────────────────

export async function networkRow(agentGroupId: string): Promise<{ idx: number; network: string } | null> {
  if (!(await workloadsReady())) return null;
  const r = (await getDb().get(`SELECT idx, network FROM workload_networks WHERE agent_group_id = ?`, agentGroupId)) as
    | { idx: number; network: string }
    | undefined;
  return r ?? null;
}

/** Claim the lowest free network index for an agent. */
export async function claimNetwork(
  agentGroupId: string,
  name: (idx: number) => string,
  max: number,
): Promise<{ idx: number; network: string }> {
  const existing = await networkRow(agentGroupId);
  if (existing) return existing;
  const used = new Set(
    ((await getDb().all(`SELECT idx FROM workload_networks`)) as { idx: number }[]).map((r) => r.idx),
  );
  let idx = 0;
  while (used.has(idx)) idx++;
  if (idx >= max) throw new Error('no workload networks left on this node');
  await getDb().run(
    `INSERT INTO workload_networks (agent_group_id, idx, network, created_at) VALUES (?, ?, ?, ?)`,
    agentGroupId,
    idx,
    name(idx),
    Date.now(),
  );
  return { idx, network: name(idx) };
}

export async function allNetworks(): Promise<Array<{ agentGroupId: string; idx: number; network: string }>> {
  if (!(await workloadsReady())) return [];
  return (
    (await getDb().all(`SELECT agent_group_id, idx, network FROM workload_networks`)) as Array<{
      agent_group_id: string;
      idx: number;
      network: string;
    }>
  ).map((r) => ({ agentGroupId: r.agent_group_id, idx: r.idx, network: r.network }));
}

// ── quotas ────────────────────────────────────────────────────────────────────

export const DEFAULT_QUOTA: Quota & { diskGb: number } = { memoryMb: 4096, cpus: 2, diskGb: 20 };

export async function quotaFor(agentGroupId: string): Promise<Quota & { diskGb: number }> {
  const r = (await getDb().get(
    `SELECT memory_mb, cpus, disk_gb FROM workload_quotas WHERE agent_group_id = ?`,
    agentGroupId,
  )) as { memory_mb: number; cpus: number; disk_gb: number } | undefined;
  return r ? { memoryMb: r.memory_mb, cpus: r.cpus, diskGb: r.disk_gb } : DEFAULT_QUOTA;
}

export async function setQuota(agentGroupId: string, q: Quota & { diskGb: number }): Promise<void> {
  await getDb().run(
    `INSERT INTO workload_quotas (agent_group_id, memory_mb, cpus, disk_gb, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_group_id) DO UPDATE SET memory_mb = excluded.memory_mb, cpus = excluded.cpus,
       disk_gb = excluded.disk_gb, updated_at = excluded.updated_at`,
    agentGroupId,
    q.memoryMb,
    q.cpus,
    q.diskGb,
    Date.now(),
  );
}

// ── builds started without a card (rate limit, survives restarts) ────────────

/** Record one build at `now` and return how many this agent started since `since` (this one included). */
export async function noteBuild(agentGroupId: string, now: number, since: number): Promise<number> {
  const db = getDb();
  await db.run(`DELETE FROM workload_builds WHERE at < ?`, since);
  await db.run(`INSERT INTO workload_builds (agent_group_id, at) VALUES (?, ?)`, agentGroupId, now);
  const r = (await db.get(
    `SELECT COUNT(*) AS n FROM workload_builds WHERE agent_group_id = ? AND at >= ?`,
    agentGroupId,
    since,
  )) as { n: number };
  return r.n;
}

export async function buildsSince(agentGroupId: string, since: number): Promise<number> {
  const r = (await getDb().get(
    `SELECT COUNT(*) AS n FROM workload_builds WHERE agent_group_id = ? AND at >= ?`,
    agentGroupId,
    since,
  )) as { n: number };
  return r.n;
}

// ── registries a build may reach (per agent, set by an owner) ─────────────────

export async function buildRegistries(agentGroupId: string): Promise<string[]> {
  if (!(await hasTable(getDb(), 'workload_build_registries'))) return [];
  const r = (await getDb().get(
    `SELECT hosts_json FROM workload_build_registries WHERE agent_group_id = ?`,
    agentGroupId,
  )) as { hosts_json: string } | undefined;
  if (!r) return [];
  try {
    const v = JSON.parse(r.hosts_json) as unknown;
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

export async function setBuildRegistries(agentGroupId: string, hosts: string[]): Promise<void> {
  if (!hosts.length) {
    await getDb().run(`DELETE FROM workload_build_registries WHERE agent_group_id = ?`, agentGroupId);
    return;
  }
  await getDb().run(
    `INSERT INTO workload_build_registries (agent_group_id, hosts_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_group_id) DO UPDATE SET hosts_json = excluded.hosts_json, updated_at = excluded.updated_at`,
    agentGroupId,
    JSON.stringify(hosts),
    Date.now(),
  );
}
