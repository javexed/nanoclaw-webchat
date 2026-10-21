// Machine and site rows. No logic beyond mapping: the rules live in control.ts.
import { randomUUID } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import type { Machine, MachineState, Site, SizeDef } from './types.js';

interface SiteRow {
  id: string;
  backend: string;
  label: string;
  config_json: string;
  sizes_json: string;
  per_agent_cap: number;
  install_cap: number;
  auto_stop_at: string | null;
  enabled: number;
}

interface MachineRow {
  id: string;
  agent_group_id: string;
  site_id: string;
  name: string;
  size: string;
  state: MachineState;
  handle: string | null;
  private_ip: string | null;
  op_id: string;
  last_error: string | null;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const json = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const toSite = (r: SiteRow): Site => ({
  id: r.id,
  backend: r.backend,
  label: r.label,
  config: json<Record<string, unknown>>(r.config_json, {}),
  sizes: json<Record<string, SizeDef>>(r.sizes_json, {}),
  perAgentCap: r.per_agent_cap,
  installCap: r.install_cap,
  autoStopAt: r.auto_stop_at,
  enabled: r.enabled === 1,
});

const toMachine = (r: MachineRow): Machine => ({
  id: r.id,
  agentGroupId: r.agent_group_id,
  siteId: r.site_id,
  name: r.name,
  size: r.size,
  state: r.state,
  handle: r.handle,
  privateIp: r.private_ip,
  opId: r.op_id,
  lastError: r.last_error,
  expiresAt: r.expires_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const machinesReady = async (): Promise<boolean> => hasTable(getDb(), 'machines');

// ── sites ─────────────────────────────────────────────────────────────────────

export async function listSites(): Promise<Site[]> {
  if (!(await machinesReady())) return [];
  return ((await getDb().all(`SELECT * FROM machine_sites ORDER BY id`)) as SiteRow[]).map(toSite);
}

export async function getSite(id: string): Promise<Site | null> {
  const r = (await getDb().get(`SELECT * FROM machine_sites WHERE id = ?`, id)) as SiteRow | undefined;
  return r ? toSite(r) : null;
}

/** Create or replace a site. */
export async function putSite(s: Site, now = Date.now()): Promise<Site> {
  await getDb().run(
    `INSERT INTO machine_sites (id, backend, label, config_json, sizes_json, per_agent_cap, install_cap, auto_stop_at, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET backend = excluded.backend, label = excluded.label, config_json = excluded.config_json,
       sizes_json = excluded.sizes_json, per_agent_cap = excluded.per_agent_cap, install_cap = excluded.install_cap,
       auto_stop_at = excluded.auto_stop_at, enabled = excluded.enabled, updated_at = excluded.updated_at`,
    s.id,
    s.backend,
    s.label,
    JSON.stringify(s.config),
    JSON.stringify(s.sizes),
    s.perAgentCap,
    s.installCap,
    s.autoStopAt,
    s.enabled ? 1 : 0,
    now,
    now,
  );
  return (await getSite(s.id))!;
}

// ── machines ──────────────────────────────────────────────────────────────────

export async function listMachines(filter: { agentGroupId?: string; includeDeleted?: boolean } = {}): Promise<Machine[]> {
  if (!(await machinesReady())) return [];
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.agentGroupId) {
    where.push('agent_group_id = ?');
    args.push(filter.agentGroupId);
  }
  if (!filter.includeDeleted) where.push(`state <> 'deleted'`);
  const sql = `SELECT * FROM machines${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`;
  return ((await getDb().all(sql, ...args)) as MachineRow[]).map(toMachine);
}

export async function getMachine(id: string): Promise<Machine | null> {
  const r = (await getDb().get(`SELECT * FROM machines WHERE id = ?`, id)) as MachineRow | undefined;
  return r ? toMachine(r) : null;
}

/** A live (not deleted) machine of a group by name. */
export async function findMachine(agentGroupId: string, name: string): Promise<Machine | null> {
  const r = (await getDb().get(
    `SELECT * FROM machines WHERE agent_group_id = ? AND name = ? AND state <> 'deleted'`,
    agentGroupId,
    name,
  )) as MachineRow | undefined;
  return r ? toMachine(r) : null;
}

export async function insertMachine(
  m: Pick<Machine, 'agentGroupId' | 'siteId' | 'name' | 'size' | 'expiresAt' | 'createdBy'>,
  now = Date.now(),
): Promise<Machine> {
  const id = randomUUID();
  await getDb().run(
    `INSERT INTO machines (id, agent_group_id, site_id, name, size, state, op_id, expires_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?)`,
    id,
    m.agentGroupId,
    m.siteId,
    m.name,
    m.size,
    randomUUID(),
    m.expiresAt,
    m.createdBy,
    now,
    now,
  );
  return (await getMachine(id))!;
}

export async function updateMachine(
  id: string,
  patch: Partial<Pick<Machine, 'state' | 'handle' | 'privateIp' | 'size' | 'opId' | 'lastError' | 'expiresAt'>>,
  now = Date.now(),
): Promise<Machine> {
  const cols: Record<string, string> = {
    state: 'state',
    handle: 'handle',
    privateIp: 'private_ip',
    size: 'size',
    opId: 'op_id',
    lastError: 'last_error',
    expiresAt: 'expires_at',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${cols[k]} = ?`);
    args.push(v ?? null);
  }
  sets.push('updated_at = ?');
  args.push(now, id);
  await getDb().run(`UPDATE machines SET ${sets.join(', ')} WHERE id = ?`, ...args);
  return (await getMachine(id))!;
}
