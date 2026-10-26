/**
 * Opt-in retention for sessions nobody can resume.
 *
 * Every session keeps a folder under data/v2-sessions/<agent-group>/<session>/
 * (inbound.db, outbound.db, outbox, inbox attachments, provider state) for as
 * long as its row exists, and nothing upstream removes one except deleting its
 * chat, agent or task. On a long-running install that is gigabytes of state no
 * conversation will ever read again. Off unless NANOCLAW_SESSION_KEEP_DAYS > 0.
 *
 * A session is removed only when every rule below holds (`screen`). The rules
 * err towards keeping: a session that fails any of them stays, and a later run
 * looks again.
 *
 *  1. Its container is stopped: `container_status` is 'stopped', this host has
 *     no live container for it, and no host holds a claim or stop intent.
 *  2. Nothing touched it for more than N days: the newest of last_active,
 *     created_at, and the mtimes of its heartbeat and mailbox files.
 *  3. It is not a conversation's continuation. The router resumes only active
 *     sessions, so a closed session (a spent task series) never is one. An
 *     active session is one when it is the newest active session for its
 *     (agent group, chat, thread), or the session agent-to-agent messages and
 *     agent-shared chats resume (the agent group's newest active non-system
 *     session). In practice an active session goes only when a newer one for
 *     the same conversation has replaced it.
 *  4. Nothing waits on it: no due or scheduled inbound message, no live task,
 *     no undelivered outbound message, no open question card or approval, no
 *     unconsumed wake signal.
 *  5. Its webchat room is not pinned by anyone. (Archived rooms get no
 *     exemption: archiving says the room is done with.)
 *
 * Removal closes an active session first, so neither the router nor
 * agent-to-agent routing can resume it, waits a grace period for any write that
 * resolved it just before to land, then screens it again before deleting
 * anything. The central rows go in one transaction (which also requires the
 * row to be unchanged); the files go afterwards, through AnchoredDir, which
 * never follows a symlink: the session folder is agent-writable and a planted
 * link must not steer a recursive delete outside it.
 */
import fs from 'fs';

import { AnchoredDir } from './anchored-dir.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';
import { destroySessionMailbox, sessionsBaseDir, withExistingMailboxSession } from './session-manager.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ENV_KEY = 'NANOCLAW_SESSION_KEEP_DAYS';
export const MAX_KEEP_DAYS = 36_500;
/** Long enough for any write that resolved a session just before it closed to land. */
export const DEFAULT_GRACE_MS = 30_000;
/** VACUUM the central DB only when at least this share of its pages is free. */
export const VACUUM_FREE_RATIO = 0.25;

/** Days to keep an unresumable session; 0 = keep forever (retention off). */
export function retentionDays(): number {
  const raw = process.env[ENV_KEY]?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_KEEP_DAYS) {
    log.warn('Session retention: ignoring an invalid value', { [ENV_KEY]: raw });
    return 0;
  }
  return n;
}

interface SessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  status: string;
  container_status: string;
  last_active: string | null;
  created_at: string;
}

export interface RetentionCandidate {
  sessionId: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  threadId: string | null;
  status: string;
  /** ISO time of the newest activity seen. */
  lastActivity: string;
  /** Bytes on disk under the session folder. */
  bytes: number;
}

export interface PruneReport {
  days: number;
  dryRun: boolean;
  /** What a dry run would remove, or what this run removed. */
  sessions: RetentionCandidate[];
  bytes: number;
  /** Sessions past the age limit that stayed, by the first rule that kept them. */
  kept: Record<string, number>;
  /** Removals that failed partway; the next run retries what is left. */
  errors: { sessionId: string; error: string }[];
  /** Share of the central DB's pages that are free (SQLite only). */
  centralFreeRatio: number | null;
  vacuumed: boolean;
}

export interface PruneOptions {
  days: number;
  dryRun?: boolean;
  now?: number;
  graceMs?: number;
  /** Allow a VACUUM this run if the central DB is fragmented enough. */
  allowVacuum?: boolean;
}

type Keep = string | null;

interface Context {
  cutoffMs: number;
  continuations: Set<string>;
  pinnedChats: Set<string>;
  blocked: Map<string, string>;
  isRunning: (sessionId: string) => boolean;
}

const ts = (iso: string | null | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

const isSystemThread = (row: SessionRow): boolean =>
  row.messaging_group_id === null && (row.thread_id?.startsWith('system:') ?? false);

/** Active sessions that a new message would resume (rule 3). */
function continuations(rows: SessionRow[]): Set<string> {
  const keep = new Set<string>();
  const newestByConversation = new Map<string, SessionRow>();
  const newestByAgent = new Map<string, SessionRow>();
  const activity = (r: SessionRow) => Math.max(ts(r.last_active), ts(r.created_at));
  for (const r of rows) {
    if (r.status !== 'active') continue;
    const key = `${r.agent_group_id}\0${r.messaging_group_id ?? ''}\0${r.thread_id ?? ''}`;
    const prev = newestByConversation.get(key);
    if (!prev || activity(r) > activity(prev) || (activity(r) === activity(prev) && r.id > prev.id)) {
      newestByConversation.set(key, r);
    }
    // findSessionByAgentGroup: newest active non-system session by created_at.
    if (isSystemThread(r)) continue;
    const agentPrev = newestByAgent.get(r.agent_group_id);
    if (!agentPrev || r.created_at > agentPrev.created_at) newestByAgent.set(r.agent_group_id, r);
  }
  for (const r of newestByConversation.values()) keep.add(r.id);
  for (const r of newestByAgent.values()) keep.add(r.id);
  return keep;
}

async function tableExists(name: string): Promise<boolean> {
  return getDb().hasTable(name);
}

/** Session ids something in the central DB still waits on (rule 4) or that a host holds (rule 1). */
async function centralBlocks(): Promise<Map<string, string>> {
  const db = getDb();
  const blocked = new Map<string, string>();
  const add = (rows: { session_id: string | null }[], reason: string) => {
    for (const r of rows) if (r.session_id && !blocked.has(r.session_id)) blocked.set(r.session_id, reason);
  };
  if (await tableExists('session_claims')) {
    add(
      await db.all('SELECT session_id FROM session_claims WHERE claimed_by IS NOT NULL OR stop_intent IS NOT NULL'),
      'claimed',
    );
  }
  add(await db.all('SELECT session_id FROM pending_questions'), 'open-question');
  if (await tableExists('pending_approvals')) {
    add(
      await db.all("SELECT session_id FROM pending_approvals WHERE status IN ('pending', 'awaiting_reason')"),
      'open-approval',
    );
  }
  if (await tableExists('wake_signals')) {
    add(await db.all('SELECT session_id FROM wake_signals WHERE consumed_at IS NULL'), 'wake-pending');
  }
  return blocked;
}

/** Messaging-group ids of webchat rooms someone has pinned (rule 5). */
async function pinnedChats(): Promise<Set<string>> {
  if (!(await tableExists('webchat_room_pins'))) return new Set();
  const rows = await getDb().all<{ id: string }>(
    `SELECT mg.id FROM messaging_groups mg
      WHERE mg.channel_type = 'webchat'
        AND EXISTS (SELECT 1 FROM webchat_room_pins p WHERE p.room_id = mg.platform_id)`,
  );
  return new Set(rows.map((r) => r.id));
}

function openSessionDir(row: SessionRow): AnchoredDir | null {
  if (!isSafeAttachmentName(row.agent_group_id) || !isSafeAttachmentName(row.id)) {
    throw new Error('session or agent group id is not a plain directory name');
  }
  return AnchoredDir.open(sessionsBaseDir(), [row.agent_group_id, row.id]);
}

/** Newest mtime among the files a live session keeps touching. */
function fileActivityMs(row: SessionRow): number {
  const dir = openSessionDir(row);
  if (!dir) return 0;
  try {
    let newest = 0;
    for (const name of ['.heartbeat', 'inbound.db', 'outbound.db']) {
      try {
        newest = Math.max(newest, dir.lstat(name).mtimeMs);
      } catch {
        /* absent */
      }
    }
    return newest;
  } finally {
    dir.close();
  }
}

/** True when the mailbox holds work: due or scheduled inbound, live tasks, undelivered outbound. */
async function mailboxBusy(row: SessionRow): Promise<boolean> {
  const busy = await withExistingMailboxSession(
    row.agent_group_id,
    row.id,
    // getDueMessages returns every past-due outbound row, delivered or not; only
    // the undelivered ones are work still waiting.
    (m) => m.countDueMessages() > 0 || m.countLiveTasks() > 0 || m.getDueMessages(m.getDeliveredIds()).length > 0,
  );
  return busy ?? false;
}

/** The first rule that keeps this session, or null when it may go. Cheapest checks first. */
async function screen(row: SessionRow, ctx: Context): Promise<{ keep: Keep; lastActivityMs: number }> {
  let lastActivityMs = Math.max(ts(row.last_active), ts(row.created_at));
  const verdict = (keep: Keep) => ({ keep, lastActivityMs });
  if (lastActivityMs >= ctx.cutoffMs) return verdict('recent');
  if (row.container_status !== 'stopped' || ctx.isRunning(row.id)) return verdict('container');
  const blocked = ctx.blocked.get(row.id);
  if (blocked) return verdict(blocked);
  if (ctx.continuations.has(row.id)) return verdict('continuation');
  if (row.messaging_group_id && ctx.pinnedChats.has(row.messaging_group_id)) return verdict('pinned');
  lastActivityMs = Math.max(lastActivityMs, fileActivityMs(row));
  if (lastActivityMs >= ctx.cutoffMs) return verdict('recent');
  if (await mailboxBusy(row)) return verdict('mailbox-pending');
  return verdict(null);
}

async function buildContext(cutoffMs: number): Promise<{ rows: SessionRow[]; ctx: Context }> {
  const rows = await getDb().all<SessionRow>(
    `SELECT id, agent_group_id, messaging_group_id, thread_id, status, container_status, last_active, created_at
       FROM sessions`,
  );
  // Lazy: container-runner pulls in the container runtime and gateway SDK.
  const { isContainerRunning } = await import('./container-runner.js');
  return {
    rows,
    ctx: {
      cutoffMs,
      continuations: continuations(rows),
      pinnedChats: await pinnedChats(),
      blocked: await centralBlocks(),
      isRunning: isContainerRunning,
    },
  };
}

// ── Anchored walk ──

function diskBytes(st: fs.Stats): number {
  return typeof st.blocks === 'number' && st.blocks > 0 ? st.blocks * 512 : st.size;
}

/** Bytes under `name` in `parent`, never following a symlink. */
function measureEntry(parent: AnchoredDir, name: string): number {
  const st = parent.lstat(name);
  if (!st.isDirectory()) return diskBytes(st);
  const dir = parent.openDir(name);
  if (!dir) return 0;
  let bytes = diskBytes(st);
  try {
    for (const entry of dir.entries()) bytes += measureEntry(dir, entry);
  } finally {
    dir.close();
  }
  return bytes;
}

/**
 * Remove `name` in `parent` and everything under it; returns the bytes freed.
 * A symlink is unlinked as itself, never followed; a directory is opened with
 * O_NOFOLLOW through its parent's descriptor, so swapping one for a link
 * mid-walk makes the walk throw rather than descend somewhere else.
 */
export function removeEntry(parent: AnchoredDir, name: string): number {
  const st = parent.lstat(name);
  if (!st.isDirectory()) {
    parent.unlink(name);
    return diskBytes(st);
  }
  const dir = parent.openDir(name);
  if (!dir) return 0;
  let bytes = diskBytes(st);
  try {
    for (const entry of dir.entries()) bytes += removeEntry(dir, entry);
  } finally {
    dir.close();
  }
  parent.rmdir(name);
  return bytes;
}

function withAgentDir<T>(agentGroupId: string, fn: (dir: AnchoredDir) => T, missing: T): T {
  if (!isSafeAttachmentName(agentGroupId)) throw new Error('agent group id is not a plain directory name');
  const dir = AnchoredDir.open(sessionsBaseDir(), [agentGroupId]);
  if (!dir) return missing;
  try {
    return fn(dir);
  } finally {
    dir.close();
  }
}

function sessionBytes(agentGroupId: string, sessionId: string): number {
  return withAgentDir(
    agentGroupId,
    (dir) => {
      try {
        return measureEntry(dir, sessionId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
      }
    },
    0,
  );
}

/** Remove one session's folder through descriptors only. */
export function removeSessionFolder(agentGroupId: string, sessionId: string): number {
  if (!isSafeAttachmentName(sessionId)) throw new Error('session id is not a plain directory name');
  return withAgentDir(
    agentGroupId,
    (dir) => {
      try {
        return removeEntry(dir, sessionId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
      }
    },
    0,
  );
}

// ── Removal ──

async function closeSession(row: SessionRow): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE sessions SET status = 'closed'
      WHERE id = ? AND status = 'active' AND container_status = 'stopped' AND last_active IS ?`,
    row.id,
    row.last_active,
  );
  return res.changes > 0;
}

/** Undo this run's close. Guarded, so a session something else changed since is left alone. */
async function reopenSession(id: string): Promise<void> {
  await getDb().run(`UPDATE sessions SET status = 'active' WHERE id = ? AND status = 'closed'`, id);
}

/** Central rows, in one transaction; false when the row moved since it was screened. */
async function deleteCentralRows(row: SessionRow): Promise<boolean> {
  const db = getDb();
  const optional = {
    pending_approvals: await tableExists('pending_approvals'),
    session_claims: await tableExists('session_claims'),
    delivery_attempts: await tableExists('delivery_attempts'),
    wake_signals: await tableExists('wake_signals'),
  };
  return db.transaction(async () => {
    // Lock the row first and require it unchanged, so a write that bumped it
    // since the screen keeps the session.
    const locked = await db.run(
      `UPDATE sessions SET status = status
        WHERE id = ? AND status = 'closed' AND container_status = 'stopped' AND last_active IS ?`,
      row.id,
      row.last_active,
    );
    if (locked.changes === 0) return false;
    await db.run('DELETE FROM pending_questions WHERE session_id = ?', row.id);
    for (const [table, present] of Object.entries(optional)) {
      if (present) await db.run(`DELETE FROM ${table} WHERE session_id = ?`, row.id);
    }
    await db.run('DELETE FROM sessions WHERE id = ?', row.id);
    return true;
  });
}

async function freshRow(id: string): Promise<SessionRow | undefined> {
  return getDb().get<SessionRow>(
    `SELECT id, agent_group_id, messaging_group_id, thread_id, status, container_status, last_active, created_at
       FROM sessions WHERE id = ?`,
    id,
  );
}

/** Share of the central DB's pages on the freelist, or null when it is not SQLite. */
export async function centralFreeRatio(): Promise<number | null> {
  const db = getDb();
  if (db.dialect !== 'sqlite') return null;
  const pages = (await db.get<{ page_count: number }>('PRAGMA page_count'))?.page_count ?? 0;
  const free = (await db.get<{ freelist_count: number }>('PRAGMA freelist_count'))?.freelist_count ?? 0;
  return pages > 0 ? free / pages : 0;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function pruneSessions(opts: PruneOptions): Promise<PruneReport> {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  const report: PruneReport = {
    days: opts.days,
    dryRun,
    sessions: [],
    bytes: 0,
    kept: {},
    errors: [],
    centralFreeRatio: null,
    vacuumed: false,
  };
  if (!(opts.days > 0)) throw new Error('retention days must be greater than 0');
  const cutoffMs = now - opts.days * DAY_MS;

  const { rows, ctx } = await buildContext(cutoffMs);
  const eligible: { row: SessionRow; lastActivityMs: number }[] = [];
  for (const row of rows) {
    let verdict: { keep: Keep; lastActivityMs: number };
    try {
      verdict = await screen(row, ctx);
    } catch (err) {
      report.errors.push({ sessionId: row.id, error: String(err) });
      continue;
    }
    if (verdict.keep === null) eligible.push({ row, lastActivityMs: verdict.lastActivityMs });
    else if (verdict.keep !== 'recent') report.kept[verdict.keep] = (report.kept[verdict.keep] ?? 0) + 1;
  }

  const candidate = (row: SessionRow, lastActivityMs: number, bytes: number): RetentionCandidate => ({
    sessionId: row.id,
    agentGroupId: row.agent_group_id,
    messagingGroupId: row.messaging_group_id,
    threadId: row.thread_id,
    status: row.status,
    lastActivity: new Date(lastActivityMs).toISOString(),
    bytes,
  });

  if (dryRun) {
    for (const { row, lastActivityMs } of eligible) {
      let bytes = 0;
      try {
        bytes = sessionBytes(row.agent_group_id, row.id);
      } catch (err) {
        report.errors.push({ sessionId: row.id, error: String(err) });
      }
      report.sessions.push(candidate(row, lastActivityMs, bytes));
      report.bytes += bytes;
    }
    report.centralFreeRatio = await centralFreeRatio();
    return report;
  }

  // Close active ones first, so nothing resumes them, and let in-flight writes land.
  const closedHere = new Set<string>();
  for (const e of eligible) {
    if (e.row.status !== 'active') continue;
    if (await closeSession(e.row)) {
      e.row.status = 'closed';
      closedHere.add(e.row.id);
    }
  }
  if (closedHere.size > 0) await sleep(opts.graceMs ?? DEFAULT_GRACE_MS);

  // Screen again against fresh state: rows, claims, mail, file times.
  const fresh = await buildContext(cutoffMs);
  for (const { row: screened } of eligible) {
    const row = await freshRow(screened.id);
    if (!row || row.status !== 'closed') continue;
    const again = await screen(row, fresh.ctx);
    if (again.keep !== null) {
      if (again.keep === 'mailbox-pending' || again.keep === 'recent') {
        log.warn('Session retention: a closed session received work during the grace period; kept', {
          sessionId: row.id,
          rule: again.keep,
        });
      }
      // This run closed it only to delete it; a kept session goes back to how it was.
      if (closedHere.has(row.id)) await reopenSession(row.id);
      continue;
    }
    try {
      if (!(await deleteCentralRows(row))) {
        if (closedHere.has(row.id)) await reopenSession(row.id);
        continue;
      }
    } catch (err) {
      report.errors.push({ sessionId: row.id, error: String(err) });
      continue;
    }
    let bytes = 0;
    try {
      await destroySessionMailbox(row.agent_group_id, row.id);
      bytes = removeSessionFolder(row.agent_group_id, row.id);
    } catch (err) {
      // The row is gone; what is left on disk is unreachable state, logged for the operator.
      report.errors.push({ sessionId: row.id, error: String(err) });
    }
    report.sessions.push(candidate(row, again.lastActivityMs, bytes));
    report.bytes += bytes;
  }

  report.centralFreeRatio = await centralFreeRatio();
  if (
    opts.allowVacuum &&
    report.sessions.length > 0 &&
    report.centralFreeRatio !== null &&
    report.centralFreeRatio >= VACUUM_FREE_RATIO
  ) {
    await getDb().exec('VACUUM');
    report.vacuumed = true;
  }
  return report;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** One-line summary for the log and the CLI. */
export function summarize(r: PruneReport): string {
  const kept = Object.entries(r.kept)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  const verb = r.dryRun ? 'would remove' : 'removed';
  return (
    `${verb} ${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'} idle over ${r.days} days ` +
    `(${formatBytes(r.bytes)})` +
    (kept ? `; kept past the limit: ${kept}` : '') +
    (r.errors.length ? `; ${r.errors.length} failed` : '') +
    (r.vacuumed ? '; central DB vacuumed' : '')
  );
}
