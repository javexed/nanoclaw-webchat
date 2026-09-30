/**
 * Runner machines and placements — the tables behind pairing and the laptop
 * tools (runner-tools.ts).
 *
 * A machine row is created on the first authenticated `hello` from a
 * fingerprint and stays `pending` until an owner/global admin approves the
 * pairing card. The pairing binds one user to one fingerprint: a hello for a
 * known fingerprint from a different user is refused, never re-bound. A
 * placement assigns an agent group to an approved machine; revoking a
 * machine drops its placements so nothing is left pointing at a laptop the
 * owner has cut off.
 */
import crypto from 'crypto';

import { getDb } from '../../db/connection.js';

export type RunnerMachineStatus = 'pending' | 'approved' | 'revoked';

/**
 * Is this runner-supplied identifier safe to store, render and join into a path?
 * Fingerprints (64 hex) and session-key fields all fit; `/`, `..`, quotes and
 * markup do not. Anything a runner sends that names a machine or a session
 * passes through this before it is used.
 */
export const RUNNER_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
export function isSafeRunnerId(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${RUNNER_ID}$`).test(value);
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
  /** Ed25519 public key (SPKI DER, base64) the machine proves on connect; null until bound. */
  public_key: string | null;
  /** 1: paired before keys existed, may connect without one until it binds one. */
  keyless_allowed?: number;
}

/** Always 'tools' now; 'container' is only read, on rows written before the laptop container was retired. */
export type PlacementMode = 'container' | 'tools';

export interface RunnerPlacementRow {
  agent_group_id: string;
  fingerprint: string;
  slots_json: string;
  created_by: string;
  created_at: number;
  /** 'tools': the agent runs on central, using the machine's laptop tools. Older rows may say 'container' (or nothing); startup converts them. */
  mode?: PlacementMode;
  /** Authenticates the agent's container to central's laptop-tools endpoint. */
  tools_token?: string | null;
}

export interface MachineSeen {
  fingerprint: string;
  userId: string;
  hostname: string;
  os: string;
  arch: string;
  runnerVersion: string;
  /** Recorded only when the row is created; an existing machine binds through bindMachineKey. */
  publicKey?: string;
}

/** What the runner socket needs from the registry — small so tests can fake it. */
export interface RunnerRegistryPort {
  recordMachineSeen(seen: MachineSeen): Promise<RunnerMachineRow>;
  getMachine(fingerprint: string): Promise<RunnerMachineRow | undefined>;
  bindMachineKey(fingerprint: string, publicKey: string): Promise<boolean>;
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
         (fingerprint, user_id, hostname, os, arch, runner_version, status, first_seen, last_seen, public_key)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      seen.fingerprint,
      seen.userId,
      seen.hostname,
      seen.os,
      seen.arch,
      seen.runnerVersion,
      now,
      now,
      seen.publicKey ?? null,
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

/**
 * Bind a key to a machine that has none. Never replaces a bound key: false
 * when one is already there (the caller compares and refuses on a mismatch).
 */
export async function bindMachineKey(fingerprint: string, publicKey: string): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE webchat_runner_machines SET public_key = ?, keyless_allowed = 0 WHERE fingerprint = ? AND public_key IS NULL`,
    publicKey,
    fingerprint,
  );
  return (r as { changes?: number }).changes !== 0;
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

/**
 * Revoke a machine, clear its key and drop its placements in one transaction.
 * Re-approval binds a key again: keyless entry is gone for good.
 */
export async function revokeMachine(
  fingerprint: string,
  by: string,
  now: number = Date.now(),
): Promise<RunnerMachineRow | undefined> {
  const db = getDb();
  await db.transaction(async () => {
    await db.run(
      `UPDATE webchat_runner_machines
         SET status = 'revoked', revoked_by = ?, revoked_at = ?, approval_id = NULL, public_key = NULL,
             keyless_allowed = 0
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
  // The token is kept across updates: the group's config holds it.
  const prior = await getPlacement(agentGroupId);
  const token = prior?.tools_token ?? crypto.randomBytes(32).toString('base64url');
  await getDb().run(
    `INSERT OR REPLACE INTO webchat_runner_placements
       (agent_group_id, fingerprint, slots_json, created_by, created_at, mode, tools_token)
     VALUES (?, ?, '{}', ?, ?, 'tools', ?)`,
    agentGroupId,
    fingerprint,
    by,
    now,
    token,
  );
  return (await getPlacement(agentGroupId)) as RunnerPlacementRow;
}

/** The tools-mode placement this token authenticates, if any. */
export async function getPlacementByToolsToken(token: string): Promise<RunnerPlacementRow | undefined> {
  if (!token) return undefined;
  return (await getDb().get(
    `SELECT * FROM webchat_runner_placements WHERE tools_token = ? AND mode = 'tools'`,
    token,
  )) as RunnerPlacementRow | undefined;
}

export async function deletePlacement(agentGroupId: string): Promise<boolean> {
  const r = await getDb().run(`DELETE FROM webchat_runner_placements WHERE agent_group_id = ?`, agentGroupId);
  return (r as { changes?: number }).changes !== 0;
}

export const runnerRegistry: RunnerRegistryPort = { recordMachineSeen, getMachine, bindMachineKey };
