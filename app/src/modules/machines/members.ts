/**
 * Machines that joined NanoClaw, and the one-time tokens they join with
 * (docs/webchat/scaling.md). The rules live here too —
 * there is little of it: spend a token once, recognise a machine by its
 * certificate fingerprint, fold health reports into the capacity it offers.
 */
import crypto, { randomUUID } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import { computeAvailable, updatePeaks, type Available, type Peaks } from './capacity.js';

export const ROLES = ['worker'] as const;
export type Role = (typeof ROLES)[number];
export type MemberState = 'ready' | 'draining' | 'revoked';

/** Join tokens last an hour. */
export const TOKEN_TTL_MS = 3600_000;
/** A machine that has not reported for 3 minutes is unhealthy (it reports every minute). */
export const UNHEALTHY_AFTER_MS = 3 * 60_000;
/**
 * A worker runs its isolation check at start and every half hour; a passing
 * result older than this no longer counts, so a worker that stopped checking
 * takes no new stacks.
 */
export const ISOLATION_FRESH_MS = 45 * 60_000;

/** A worker's own workload isolation check (worker-main.ts): could a workload reach that machine? */
export type Isolation = 'ok' | 'open' | 'unknown';
export const ISOLATIONS: readonly Isolation[] = ['ok', 'open', 'unknown'];

export interface Facts {
  hostname?: string;
  os?: string;
  cpus: number;
  memTotalMb: number;
  diskTotalGb?: number;
}

/** One health report. `nanoclaw*` = what NanoClaw's own slice uses; the rest is other software. */
export interface Health {
  cpus: number;
  memTotalMb: number;
  memUsedMb: number;
  memNanoclawMb: number;
  cpuUsed: number;
  cpuNanoclaw: number;
  diskTotalGb: number;
  diskFreeGb: number;
  load1?: number;
  agentVersion?: string;
  /** Sent by the worker service only (worker-main.ts); report.sh leaves it out. */
  isolation?: Isolation;
  /** How long ago the worker ran that check. */
  isolationAgeMs?: number;
}

export interface Member {
  id: string;
  name: string;
  role: Role;
  provider: 'manual';
  state: MemberState;
  facts: Facts;
  health: Health | null;
  peaks: Peaks;
  lastReport: number | null;
  certFp: string | null;
  certExpires: number | null;
  prevCertFp: string | null;
  prevCertExpires: number | null;
  capMemoryMb: number | null;
  capCpus: number | null;
  /** An owner turned "Run workloads here" on: new stacks may be placed here. */
  workloadsOn: boolean;
  /** The latest isolation check the worker reported, and when it ran (central's clock). */
  isolation: Isolation | null;
  isolationAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  name: string;
  role: Role;
  provider: 'manual';
  state: MemberState;
  facts_json: string;
  health_json: string | null;
  peaks_json: string;
  last_report: number | null;
  cert_fp: string | null;
  cert_expires: number | null;
  prev_cert_fp: string | null;
  prev_cert_expires: number | null;
  cap_memory_mb: number | null;
  cap_cpus: number | null;
  workloads_on?: number | null;
  isolation?: string | null;
  isolation_at?: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const parse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const toMember = (r: Row): Member => ({
  id: r.id,
  name: r.name,
  role: r.role,
  provider: r.provider,
  state: r.state,
  facts: parse<Facts>(r.facts_json, { cpus: 0, memTotalMb: 0 }),
  health: parse<Health | null>(r.health_json, null),
  peaks: parse<Peaks>(r.peaks_json, {}),
  lastReport: r.last_report,
  certFp: r.cert_fp,
  certExpires: r.cert_expires,
  prevCertFp: r.prev_cert_fp,
  prevCertExpires: r.prev_cert_expires,
  capMemoryMb: r.cap_memory_mb,
  capCpus: r.cap_cpus,
  workloadsOn: r.workloads_on === 1,
  isolation: ISOLATIONS.includes(r.isolation as Isolation) ? (r.isolation as Isolation) : null,
  isolationAt: r.isolation_at ?? null,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const membersReady = async (): Promise<boolean> => hasTable(getDb(), 'machine_members');

const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

// ── join tokens ──────────────────────────────────────────────────────────────

/** A new one-time join token; only its hash is stored. */
export async function createJoinToken(
  role: Role,
  createdBy: string | null,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + TOKEN_TTL_MS;
  await getDb().run(
    `INSERT INTO machine_join_tokens (token_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
    hashToken(token),
    role,
    createdBy,
    now,
    expiresAt,
  );
  return { token, expiresAt };
}

/** Spend a token: its role when it was unused and unexpired, else null. Never twice. */
export async function spendJoinToken(token: string, now = Date.now()): Promise<Role | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const h = hashToken(token);
  const row = (await getDb().get(`SELECT role FROM machine_join_tokens WHERE token_hash = ?`, h)) as
    | { role: Role }
    | undefined;
  if (!row) return null;
  const r = await getDb().run(
    `UPDATE machine_join_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    now,
    h,
    now,
  );
  return r.changes === 1 ? row.role : null;
}

async function linkToken(token: string, machineId: string): Promise<void> {
  await getDb().run(`UPDATE machine_join_tokens SET machine_id = ? WHERE token_hash = ?`, machineId, hashToken(token));
}

// ── machines ─────────────────────────────────────────────────────────────────

export async function listMembers(): Promise<Member[]> {
  if (!(await membersReady())) return [];
  return ((await getDb().all(`SELECT * FROM machine_members ORDER BY created_at`)) as Row[]).map(toMember);
}

export async function getMember(id: string): Promise<Member | null> {
  const r = (await getDb().get(`SELECT * FROM machine_members WHERE id = ?`, id)) as Row | undefined;
  return r ? toMember(r) : null;
}

/** The machine a client certificate belongs to — current, or the previous one until it expires. */
export async function memberByCert(fp: string, now = Date.now()): Promise<Member | null> {
  if (!fp) return null;
  const r = (await getDb().get(
    `SELECT * FROM machine_members WHERE cert_fp = ? OR (prev_cert_fp = ? AND prev_cert_expires > ?)`,
    fp,
    fp,
    now,
  )) as Row | undefined;
  return r ? toMember(r) : null;
}

const cleanName = (s: unknown): string =>
  (typeof s === 'string' ? s : '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 63) || 'machine';

/** Record a machine that just joined with `token`, holding certificate `fp`. */
export async function addMember(
  token: string,
  role: Role,
  facts: Facts,
  cert: { fingerprint: string; expiresAt: number },
  now = Date.now(),
): Promise<Member> {
  const id = `m-${randomUUID().slice(0, 8)}`;
  const base = cleanName(facts.hostname);
  const taken = new Set((await listMembers()).map((m) => m.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  const f: Facts = {
    hostname: cleanName(facts.hostname),
    os: typeof facts.os === 'string' ? facts.os.slice(0, 80) : undefined,
    cpus: Math.max(0, Number(facts.cpus) || 0),
    memTotalMb: Math.max(0, Math.round(Number(facts.memTotalMb) || 0)),
    diskTotalGb: Math.max(0, Number(facts.diskTotalGb) || 0),
  };
  await getDb().run(
    `INSERT INTO machine_members (id, name, role, provider, state, facts_json, peaks_json, cert_fp, cert_expires, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', 'ready', ?, '{}', ?, ?, ?, ?)`,
    id,
    name,
    role,
    JSON.stringify(f),
    cert.fingerprint,
    cert.expiresAt,
    now,
    now,
  );
  await linkToken(token, id);
  return (await getMember(id))!;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * The isolation part of a report: the state, and when the check ran by
 * central's clock (now minus the age the worker gives, so the two clocks need
 * not agree). Without a usable age it counts as never run: it cannot pass
 * placement's freshness test. Null when the report has none (report.sh).
 */
export function isolationOf(raw: Partial<Health>, now: number): { state: Isolation; at: number | null } | null {
  if (!ISOLATIONS.includes(raw.isolation as Isolation)) return null;
  const age = Number(raw.isolationAgeMs);
  const at = Number.isFinite(age) && age >= 0 && age <= 7 * 86_400_000 ? now - Math.round(age) : null;
  return { state: raw.isolation as Isolation, at };
}

/** Fold a health report in: latest health, daily peaks of non-NanoClaw use, the worker's isolation check. */
export async function recordHealth(id: string, raw: Partial<Health>, now = Date.now()): Promise<Member | null> {
  const m = await getMember(id);
  if (!m) return null;
  const h: Health = {
    cpus: num(raw.cpus) || m.facts.cpus,
    memTotalMb: num(raw.memTotalMb) || m.facts.memTotalMb,
    memUsedMb: num(raw.memUsedMb),
    memNanoclawMb: num(raw.memNanoclawMb),
    cpuUsed: num(raw.cpuUsed),
    cpuNanoclaw: num(raw.cpuNanoclaw),
    diskTotalGb: num(raw.diskTotalGb),
    diskFreeGb: num(raw.diskFreeGb),
    load1: raw.load1 === undefined ? undefined : num(raw.load1),
    agentVersion: typeof raw.agentVersion === 'string' ? raw.agentVersion.slice(0, 40) : undefined,
  };
  const iso = isolationOf(raw, now);
  if (iso)
    await getDb().run(`UPDATE machine_members SET isolation = ?, isolation_at = ? WHERE id = ?`, iso.state, iso.at, id);
  const peaks = updatePeaks(m.peaks, { memMb: h.memUsedMb - h.memNanoclawMb, cpus: h.cpuUsed - h.cpuNanoclaw }, now);
  await getDb().run(
    `UPDATE machine_members SET health_json = ?, peaks_json = ?, last_report = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(h),
    JSON.stringify(peaks),
    now,
    now,
    id,
  );
  return getMember(id);
}

/** A renewed certificate; the previous one stays valid until it expires (a renewal in flight). */
export async function rotateCert(
  id: string,
  cert: { fingerprint: string; expiresAt: number },
  now = Date.now(),
): Promise<void> {
  await getDb().run(
    `UPDATE machine_members SET prev_cert_fp = cert_fp, prev_cert_expires = cert_expires, cert_fp = ?, cert_expires = ?, updated_at = ? WHERE id = ?`,
    cert.fingerprint,
    cert.expiresAt,
    now,
    id,
  );
}

export async function setMemberState(id: string, state: MemberState, now = Date.now()): Promise<boolean> {
  const r = await getDb().run(`UPDATE machine_members SET state = ?, updated_at = ? WHERE id = ?`, state, now, id);
  return r.changes === 1;
}

/** "Run workloads here": new stacks may be placed on this machine (placement.ts). Off by default. */
export async function setWorkloadsOn(id: string, on: boolean, now = Date.now()): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE machine_members SET workloads_on = ?, updated_at = ? WHERE id = ?`,
    on ? 1 : 0,
    now,
    id,
  );
  return r.changes === 1;
}

/** Revoke: refused from now on, certificates forgotten so renewal is impossible. */
export async function revokeMember(id: string, now = Date.now()): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE machine_members SET state = 'revoked', cert_fp = NULL, prev_cert_fp = NULL, updated_at = ? WHERE id = ?`,
    now,
    id,
  );
  return r.changes === 1;
}

export async function removeMember(id: string): Promise<boolean> {
  const r = await getDb().run(`DELETE FROM machine_members WHERE id = ? AND state = 'revoked'`, id);
  return r.changes === 1;
}

export async function setCap(
  id: string,
  cap: { memMb: number | null; cpus: number | null },
  now = Date.now(),
): Promise<boolean> {
  const memMb = cap.memMb === null ? null : Math.max(0, Math.round(cap.memMb));
  const cpus = cap.cpus === null ? null : Math.max(0, cap.cpus);
  const r = await getDb().run(
    `UPDATE machine_members SET cap_memory_mb = ?, cap_cpus = ?, updated_at = ? WHERE id = ?`,
    memMb,
    cpus,
    now,
    id,
  );
  return r.changes === 1;
}

/** What NanoClaw may use on a machine, from its totals, peaks and the owner's cap. */
export function availableOn(m: Member): Available {
  const totals = {
    memMb: m.health?.memTotalMb || m.facts.memTotalMb,
    cpus: m.health?.cpus || m.facts.cpus,
  };
  return computeAvailable(totals, m.peaks, { memMb: m.capMemoryMb, cpus: m.capCpus });
}

export const isHealthy = (m: Member, now = Date.now()): boolean =>
  m.state !== 'revoked' && m.lastReport !== null && now - m.lastReport < UNHEALTHY_AFTER_MS;

/**
 * Where a worker's isolation stands for placement: 'ok' only for a passing
 * check that is recent; 'open' when the last check got through (whatever its
 * age); 'stale' for a pass that is too old; 'unknown' when it never reported one.
 */
export type IsolationStatus = 'ok' | 'open' | 'stale' | 'unknown';
export function isolationStatus(m: Pick<Member, 'isolation' | 'isolationAt'>, now = Date.now()): IsolationStatus {
  if (m.isolation === 'open') return 'open';
  if (m.isolation !== 'ok') return 'unknown';
  return m.isolationAt !== null && now - m.isolationAt < ISOLATION_FRESH_MS ? 'ok' : 'stale';
}

/** Why a worker may not take workloads now, or null when its isolation check passed recently. */
export function isolationRefusal(
  m: Pick<Member, 'name' | 'isolation' | 'isolationAt'>,
  now = Date.now(),
): string | null {
  const s = isolationStatus(m, now);
  if (s === 'ok') return null;
  const why =
    s === 'open'
      ? 'a workload there could reach the machine itself: its host rules are missing'
      : s === 'stale'
        ? 'its last check is too old'
        : 'it has not reported one yet';
  return `worker ${m.name} hasn't passed the isolation check (${why})`;
}

/** Shown to admins: no fingerprints. */
export function publicView(m: Member, now = Date.now()) {
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    provider: m.provider,
    state: m.state,
    healthy: isHealthy(m, now),
    facts: m.facts,
    health: m.health,
    lastReport: m.lastReport,
    certExpires: m.certExpires,
    cap: { memMb: m.capMemoryMb, cpus: m.capCpus },
    available: availableOn(m),
    workloadsOn: m.workloadsOn,
    isolation: { status: isolationStatus(m, now), at: m.isolationAt },
    createdAt: m.createdAt,
  };
}
