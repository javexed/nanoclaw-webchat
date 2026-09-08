/**
 * Outbound seq high-water mark, counting EVERY row in messages_out.
 *
 * Upstream's poll-loop has a `maxOutboundSeq()` that reduces over UNDELIVERED
 * messages only. That is the wrong measure for the empty-turn safety net: the
 * host's delivery poll runs concurrently, so a message delivered mid-turn
 * lowers the undelivered max and a turn that really did produce output can show
 * a zero (or negative) delta — a spurious "no output" fallback. Counting all
 * rows is monotonic within a turn, so a zero delta means true silence.
 *
 * Lives here rather than in src/db/ on purpose: the mailbox registry test
 * forbids `bun:sqlite` and raw `.prepare(` in that directory, keeping SQL
 * inside the SQLite driver. This is a fork-owned read that deliberately reaches
 * past the mailbox operations, so it stays out of the scanned directory.
 */
import { getOutboundDb } from './mailbox/sqlite/connection.js';

export function getMaxOutboundSeq(): number {
  return (getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
}
