// Published apps: one row per app name, pointing at a workload's service and
// port, on one publishing route kind, with its "who can open" rule. Mapping
// only: the rules live in publish.ts.
import { randomUUID } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import type { RouteKind } from './gateway/publishing.js';

/**
 * Narrowest first: the order "widening" is measured in. `specific` (named
 * people, Cloudflare only) sits after `only-me`; a list of people is wider
 * than another unless it is a subset of it (publish.ts).
 */
export const WHO = ['only-me', 'specific', 'agent-members', 'signed-in'] as const;
export type Who = (typeof WHO)[number];
export const isWho = (v: unknown): v is Who => WHO.includes(v as Who);
export const wider = (a: Who, b: Who): boolean => WHO.indexOf(a) > WHO.indexOf(b);

export interface AppRoute {
  id: string;
  /** The app's name: one DNS label, unique on this install. */
  app: string;
  workloadId: string;
  agentGroupId: string;
  service: string;
  port: number;
  kind: RouteKind;
  who: Who;
  /** For `specific`: the email addresses that may open it (lowercase); empty otherwise. */
  emails: string[];
  /** The person "only me" means: whoever exposed it, or approved the agent's card. Null: owners only. */
  ownerUserId: string | null;
  /** Ties an agent's approved expose to the approval that carried it (see publish.ts). */
  ticket: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  app: string;
  workload_id: string;
  agent_group_id: string;
  service: string;
  port: number;
  kind: RouteKind;
  who: Who;
  emails: string | null;
  owner_user_id: string | null;
  ticket: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const toRoute = (r: Row): AppRoute => ({
  id: r.id,
  app: r.app,
  workloadId: r.workload_id,
  agentGroupId: r.agent_group_id,
  service: r.service,
  port: r.port,
  kind: r.kind,
  who: r.who,
  emails: parseEmails(r.emails),
  ownerUserId: r.owner_user_id,
  ticket: r.ticket,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function parseEmails(v: string | null): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) ? a.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

export const routesReady = async (): Promise<boolean> => hasTable(getDb(), 'workload_app_routes');

export async function listRoutes(filter: { agentGroupId?: string; workloadId?: string } = {}): Promise<AppRoute[]> {
  if (!(await routesReady())) return [];
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.agentGroupId) {
    where.push('agent_group_id = ?');
    args.push(filter.agentGroupId);
  }
  if (filter.workloadId) {
    where.push('workload_id = ?');
    args.push(filter.workloadId);
  }
  const sql = `SELECT * FROM workload_app_routes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY app`;
  return ((await getDb().all(sql, ...args)) as Row[]).map(toRoute);
}

export async function getRoute(id: string): Promise<AppRoute | null> {
  if (!id || !(await routesReady())) return null;
  const r = (await getDb().get(`SELECT * FROM workload_app_routes WHERE id = ?`, id)) as Row | undefined;
  return r ? toRoute(r) : null;
}

export async function findRouteByApp(app: string): Promise<AppRoute | null> {
  const r = (await getDb().get(`SELECT * FROM workload_app_routes WHERE app = ?`, app)) as Row | undefined;
  return r ? toRoute(r) : null;
}

export async function insertRoute(
  r: Pick<
    AppRoute,
    'app' | 'workloadId' | 'agentGroupId' | 'service' | 'port' | 'kind' | 'who' | 'ownerUserId' | 'ticket' | 'createdBy'
  > & { emails?: string[] },
  now = Date.now(),
): Promise<AppRoute> {
  const id = randomUUID();
  await getDb().run(
    `INSERT INTO workload_app_routes (id, app, workload_id, agent_group_id, service, port, kind, who, emails,
       owner_user_id, ticket, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    r.app,
    r.workloadId,
    r.agentGroupId,
    r.service,
    r.port,
    r.kind,
    r.who,
    r.emails?.length ? JSON.stringify(r.emails) : null,
    r.ownerUserId,
    r.ticket,
    r.createdBy,
    now,
    now,
  );
  return (await getRoute(id))!;
}

export async function updateRoute(
  id: string,
  patch: Partial<Pick<AppRoute, 'service' | 'port' | 'kind' | 'who' | 'emails' | 'ownerUserId' | 'ticket'>>,
  now = Date.now(),
): Promise<AppRoute> {
  const sets: string[] = [];
  const args: unknown[] = [];
  const put = (col: string, v: unknown): void => {
    sets.push(`${col} = ?`);
    args.push(v ?? null);
  };
  if (patch.service !== undefined) put('service', patch.service);
  if (patch.port !== undefined) put('port', patch.port);
  if (patch.kind !== undefined) put('kind', patch.kind);
  if (patch.who !== undefined) put('who', patch.who);
  if (patch.emails !== undefined) put('emails', patch.emails.length ? JSON.stringify(patch.emails) : null);
  if ('ownerUserId' in patch) put('owner_user_id', patch.ownerUserId);
  if ('ticket' in patch) put('ticket', patch.ticket);
  put('updated_at', now);
  args.push(id);
  await getDb().run(`UPDATE workload_app_routes SET ${sets.join(', ')} WHERE id = ?`, ...args);
  return (await getRoute(id))!;
}

export async function deleteRoute(id: string): Promise<void> {
  await getDb().run(`DELETE FROM workload_app_routes WHERE id = ?`, id);
}

/**
 * The person who approved an agent's expose becomes its "only me". Only a
 * route still waiting for one (owner unset, same ticket) is changed.
 */
export async function claimTicket(ticket: string, userId: string): Promise<boolean> {
  if (!(await routesReady())) return false;
  const r = await getDb().run(
    `UPDATE workload_app_routes SET owner_user_id = ?, ticket = NULL, updated_at = ?
     WHERE ticket = ? AND owner_user_id IS NULL`,
    userId,
    Date.now(),
    ticket,
  );
  return r.changes > 0;
}
