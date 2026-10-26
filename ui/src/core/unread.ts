// ── Unread counts ───────────────────────────────────────────────────────────
// Pure helpers behind the sidebar's count badges and the transcript's "New"
// divider. The counts are the server's: each room/thread payload carries
// `unread_count` from the user's read markers, so they survive a reload and
// agree across devices; live frames only add to them until the next payload.
// No DOM, no state import — unit-tested in Node.

/** Badge text: nothing at zero, capped so a busy room cannot widen the row. */
export function formatUnreadCount(n: number | undefined): string {
  if (!n || n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}

/** One more unread for `id` (a live message landed somewhere not on screen). */
export function bumpUnread(counts: Map<string, number>, id: string): void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

/**
 * Take the server's count for `id`. The server is authoritative, so this
 * replaces rather than adds; a flagged entry without a count (an older server)
 * still reads as unread.
 */
export function seedUnread(counts: Map<string, number>, id: string, serverCount: number | undefined): void {
  counts.set(id, Math.max(1, Number(serverCount) || 0));
}

interface HistoryMessage {
  type?: string;
  sender?: string;
  created_at?: number;
}

/**
 * Index of the first message the user has not seen, or -1 for none: the first
 * one newer than their read marker that someone else sent. Their own messages
 * never count — they were read by being written. No marker (never opened)
 * means no anchor: a first visit lands at the latest, not at the top of history.
 */
export function firstUnreadIndex(msgs: HistoryMessage[], lastReadAt: number | null | undefined, me: string): number {
  if (lastReadAt == null) return -1;
  return msgs.findIndex(
    (m) => m.type !== 'system' && typeof m.created_at === 'number' && m.created_at > lastReadAt && m.sender !== me,
  );
}
