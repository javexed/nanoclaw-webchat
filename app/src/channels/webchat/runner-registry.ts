/**
 * Runner machines and placements — the tables behind pairing and the
 * fleet driver's dispatch decision.
 *
 * A machine row is created on the first authenticated `hello` from a
 * fingerprint and stays `pending` until an owner/global admin approves the
 * pairing card. The pairing binds one user to one fingerprint: a hello for a
 * known fingerprint from a different user is refused, never re-bound. A
 * placement assigns an agent group to an approved machine; revoking a
 * machine drops its placements so nothing is left pointing at a laptop the
 * owner has cut off.
 */
import { getDb } from '../../db/connection.js';

export type RunnerMachineStatus = 'pending' | 'approved' | 'revoked';

/**
 * Is this runner-supplied identifier safe to store, render and join into a path?
 * Fingerprints (64 hex) and session-key fields all fit; `/`, `..`, quotes and
 * markup do not. Anything a runner sends that names a machine or a session
 * passes through this before it is used.
 */
export function isSafeRunnerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export interface RunnerMachineRow {
  fingerprint: string;
  user_id: string;
  hostname: string;
  os: string;
  arch: string;
  runner_version: string;
  status: RunnerMachineStatus;
  approval_id: string | null;
  approved_by: string | null;
  approved_at: number | null;
  revoked_by: string | null;
  revoked_at: number | null;
  first_seen: number;
  last_seen: number;
}

export interface RunnerPlacementRow {
  agent_group_id: string;
  fingerprint: string;
  slots_json: string;
  created_by: string;
  created_at: number;
}

export interface MachineSeen {
  fingerprint: string;
  userId: string;
  hostname: string;
  os: string;
  arch: string;
  runnerVersion: string;
}

/** What the runner socket needs from the registry — small so tests can fake it. */
export interface RunnerRegistryPort {
  recordMachineSeen(seen: MachineSeen): Promise<RunnerMachineRow>;
  getMachine(fingerprint: string): Promise<RunnerMachineRow | undefined>;
}

export class PlacementError extends Error {
  constructor(
    readonly code: 'machine-not-found' | 'machine-not-approved',
    message: string,
  ) {
    super(message);
    this.name = 'PlacementError';
  }
}

export async function getMachine(fingerprint: string): Promise<RunnerMachineRow | undefined> {
  return (await getDb().get(`SELECT * FROM webchat_runner_machines WHERE fingerprint = ?`, fingerprint)) as
    | RunnerMachineRow
    | undefined;
}

export async function listMachines(): Promise<RunnerMachineRow[]> {
  return (await getDb().all(`SELECT * FROM webchat_runner_machines ORDER BY last_seen DESC`)) as RunnerMachineRow[];
}

/**
 * Upsert on hello. A new fingerprint becomes a pending machine bound to the
 * connecting user; a known one refreshes its descriptive fields and last_seen.
 * A fingerprint bound to ANOTHER user is returned untouched — the caller sees
 * the mismatch in `user_id` and refuses; the binding is never silently moved.
 */
export async function recordMachineSeen(seen: MachineSeen, now: number = Date.now()): Promise<RunnerMachineRow> {
  const db = getDb();
  const existing = await getMachine(seen.fingerprint);
  if (!existing) {
    await db.run(
      `INSERT INTO webchat_runner_machines
         (fingerprint, user_id, hostname, os, arch, runner_version, status, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      seen.fingerprint,
      seen.userId,
      seen.hostname,
      seen.os,
      seen.arch,
      seen.runnerVersion,
      now,
      now,
    );
  } else if (existing.user_id === seen.userId) {
    await db.run(
      `UPDATE webchat_runner_machines SET hostname = ?, os = ?, arch = ?, runner_version = ?, last_seen = ?
       WHERE fingerprint = ?`,
      seen.hostname,
      seen.os,
      seen.arch,
      seen.runnerVersion,
      now,
      seen.fingerprint,
    );
  } else {
    return existing;
  }
  return (await getMachine(seen.fingerprint)) as RunnerMachineRow;
}

/** Remember which pending_approvals row is the open pairing card (null when none). */
export async function setMachineApprovalId(fingerprint: string, approvalId: string | null): Promise<void> {
  await getDb().run(
    `UPDATE webchat_runner_machines SET approval_id = ? WHERE fingerprint = ?`,
    approvalId,
    fingerprint,
  );
}

export async function approveMachine(
  fingerprint: string,
  by: string,
  now: number = Date.now(),
): Promise<RunnerMachineRow | undefined> {
  await getDb().run(
    `UPDATE webchat_runner_machines
       SET status = 'approved', approved_by = ?, approved_at = ?, approval_id = NULL, revoked_by = NULL, revoked_at = NULL
     WHERE fingerprint = ?`,
    by,
    now,
    fingerprint,
  );
  return getMachine(fingerprint);
}

/** Revoke a machine and drop its placements in one transaction. */
export async function revokeMachine(
  fingerprint: string,
  by: string,
  now: number = Date.now(),
): Promise<RunnerMachineRow | undefined> {
  const db = getDb();
  await db.transaction(async () => {
    await db.run(
      `UPDATE webchat_runner_machines
         SET status = 'revoked', revoked_by = ?, revoked_at = ?, approval_id = NULL
       WHERE fingerprint = ?`,
      by,
      now,
      fingerprint,
    );
    await db.run(`DELETE FROM webchat_runner_placements WHERE fingerprint = ?`, fingerprint);
  });
  return getMachine(fingerprint);
}

export async function listPlacements(): Promise<RunnerPlacementRow[]> {
  return (await getDb().all(
    `SELECT * FROM webchat_runner_placements ORDER BY created_at DESC`,
  )) as RunnerPlacementRow[];
}

export async function getPlacement(agentGroupId: string): Promise<RunnerPlacementRow | undefined> {
  return (await getDb().get(`SELECT * FROM webchat_runner_placements WHERE agent_group_id = ?`, agentGroupId)) as
    | RunnerPlacementRow
    | undefined;
}

/** Assign an agent group to an APPROVED machine; replaces any earlier placement of that group. */
export async function setPlacement(
  agentGroupId: string,
  fingerprint: string,
  by: string,
  slots: Record<string, unknown> = {},
  now: number = Date.now(),
): Promise<RunnerPlacementRow> {
  const machine = await getMachine(fingerprint);
  if (!machine) throw new PlacementError('machine-not-found', `no runner machine ${fingerprint.slice(0, 12)}…`);
  if (machine.status !== 'approved') {
    throw new PlacementError(
      'machine-not-approved',
      `machine ${machine.hostname || fingerprint.slice(0, 12)} is ${machine.status}, not approved`,
    );
  }
  await getDb().run(
    `INSERT OR REPLACE INTO webchat_runner_placements (agent_group_id, fingerprint, slots_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    agentGroupId,
    fingerprint,
    JSON.stringify(slots),
    by,
    now,
  );
  return (await getPlacement(agentGroupId)) as RunnerPlacementRow;
}

export async function deletePlacement(agentGroupId: string): Promise<boolean> {
  const r = await getDb().run(`DELETE FROM webchat_runner_placements WHERE agent_group_id = ?`, agentGroupId);
  return (r as { changes?: number }).changes !== 0;
}

export const runnerRegistry: RunnerRegistryPort = { recordMachineSeen, getMachine };

/**
 * Declared slots on a placement: container paths central asks the runner to
 * fill, and how. The laptop decides WHICH local directory fills each one (or
 * refuses); central decides only THAT the group gets a slot there. The
 * developer's workspace is the canonical one — it is what makes an agent on a
 * laptop useful for the code in front of the developer.
 */
export const WORKSPACE_SLOT = '/workspace/project';
export type SlotMode = 'rw' | 'ro';
export interface SlotDecl {
  mode: SlotMode;
  /** Extra secret-like globs the machine must hide inside this slot (added to its own defaults). */
  exclude?: string[];
  /**
   * Propose mode: the agent works in a self-contained copy of the developer's
   * repository; nothing touches the real working tree until the developer
   * applies the proposal, file by file, from the editor.
   */
  propose?: boolean;
}
/** A machine's coding agent proposes by default: review before anything lands in the developer's tree. */
export const DEFAULT_RUNNER_SLOTS: Record<string, SlotDecl> = { [WORKSPACE_SLOT]: { mode: 'rw', propose: true } };

/**
 * Parse `slots_json` tolerantly: `{ "/path": "rw" }` or
 * `{ "/path": { "mode": "ro", "exclude": ["*.tfvars"] } }`; junk is ignored.
 */
export function placementSlots(row: Pick<RunnerPlacementRow, 'slots_json'> | undefined): Record<string, SlotDecl> {
  if (!row) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(row.slots_json || '{}');
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, SlotDecl> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k.startsWith('/') || k.includes('..')) continue;
    const obj =
      v && typeof v === 'object' ? (v as { mode?: unknown; exclude?: unknown; propose?: unknown }) : undefined;
    const mode = typeof v === 'string' ? v : obj?.mode;
    if (mode !== 'rw' && mode !== 'ro') continue;
    const exclude = Array.isArray(obj?.exclude)
      ? (obj!.exclude as unknown[])
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 200)
          .slice(0, 100)
      : undefined;
    out[k] = {
      mode,
      ...(exclude && exclude.length ? { exclude } : {}),
      ...(obj?.propose === true ? { propose: true } : {}),
    };
  }
  return out;
}
