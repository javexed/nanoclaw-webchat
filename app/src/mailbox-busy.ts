/**
 * A session mailbox read that hit SQLite's busy lock is transient, not a fault.
 *
 * The host reads a session's outbound.db while its container writes it. A
 * normal commit holds the lock for milliseconds; the read waits out the
 * connection's busy_timeout. What outlasts that is a stall below SQLite — on
 * this kind of install, typically a hypervisor snapshot backup slowing the
 * guest's writes for a few seconds. The delivery poll and the sweep both run
 * again a moment later, so the right response is to skip this round quietly.
 *
 * Deliberately NOT a longer busy_timeout: better-sqlite3 is synchronous, so a
 * longer wait would freeze the whole host (every channel, every delivery) for
 * the length of the stall instead of skipping one session for one tick.
 */
import { log } from './log.js';

const WARN_WINDOW_MS = 60_000;
const lastWarned = new Map<string, { at: number; skipped: number }>();

export function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_BUSY_RECOVERY';
}

/**
 * True when `err` is a busy lock — the caller returns and lets its next tick
 * retry. Logs one warning per session per minute, carrying how many rounds it
 * skipped since the last one. False for anything else, which the caller
 * reports as before.
 */
export function skipMailboxBusy(
  op: 'delivery' | 'sweep',
  agentGroupId: string,
  sessionId: string,
  err: unknown,
  now = Date.now(),
): boolean {
  if (!isSqliteBusy(err)) return false;
  const key = `${op}:${sessionId}`;
  const prev = lastWarned.get(key);
  if (prev && now - prev.at < WARN_WINDOW_MS) {
    prev.skipped += 1;
    return true;
  }
  if (lastWarned.size > 1000) lastWarned.clear();
  log.warn('Session mailbox busy — skipping this round, retrying on the next', {
    op,
    agentGroupId,
    sessionId,
    skippedSinceLastWarning: prev?.skipped ?? 0,
  });
  lastWarned.set(key, { at: now, skipped: 0 });
  return true;
}

/** Test hook. */
export function _resetMailboxBusyWarnings(): void {
  lastWarned.clear();
}
