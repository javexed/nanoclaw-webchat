// ── Retry when the limit lifts ──────────────────────────────────────────────
// Pure logic for the control on a rate-limit notice (LimitRetry.vue): whether
// it offers a retry, shows one pending, or shows nothing. The server keeps one
// pending retry per room thread (limit-retry.ts), so while any notice in the
// thread has one, the others offer nothing.

export interface LimitNotice {
  limitResetsAt?: number | null;
  limitRetryAt?: number | null;
  limitThread?: string | null;
}

export type LimitRetryView = 'offer' | 'scheduled' | null;

export function limitRetryView(row: LimitNotice, rows: readonly LimitNotice[], now: number): LimitRetryView {
  if (row.limitResetsAt == null) return null;
  if (row.limitRetryAt != null) return 'scheduled';
  if (row.limitResetsAt <= now) return null;
  const pendingInThread = rows.some((r) => r.limitRetryAt != null && r.limitThread === row.limitThread);
  return pendingInThread ? null : 'offer';
}

/** "15:05" today, else "Jan 2, 15:05". */
export function limitRetryTime(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** Cancel is offered to who scheduled it, or to a room admin — the server's rule. */
export function canCancelLimitRetry(by: string | null | undefined, me: string, roomAdmin: boolean): boolean {
  return roomAdmin || (!!by && by === me);
}

/**
 * The pending retry a 409 carries (the thread already has one), or null. It
 * can sit on another notice in the thread, so it names its notice.
 */
export function conflictRetry(body: unknown): { noticeId: string | null; retryAt: number; by: string | null } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.retry_at !== 'number') return null;
  return {
    noticeId: typeof b.notice_id === 'string' ? b.notice_id : null,
    retryAt: b.retry_at,
    by: typeof b.by === 'string' ? b.by : null,
  };
}
