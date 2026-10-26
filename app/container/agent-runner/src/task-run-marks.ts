/**
 * Task-run marks: what the host cannot see from the inbound row alone.
 *
 * A task occurrence ends `completed` whether the model answered or errored, and
 * a container that dies leaves the row `pending` whether it died before the
 * query or halfway through it. The host's retry and alert policy needs both
 * distinctions, so this module records them in a `task_run_marks` side-table in
 * outbound.db (the container is that file's writer; the host only reads it):
 *
 *   reached_at — set when a query starts with the row in flight. A row that has
 *                it was seen by the model; re-running it could repeat whatever
 *                the first attempt already did, so the host never retries it.
 *   outcome    — 'error' when the turn failed (an error result, or a query that
 *                threw), 'ok' when a later result for the same rows succeeded.
 *                Last write wins, so a turn an escalation handler recovered
 *                ends 'ok'.
 *
 * Only task sessions record anything. Best-effort throughout: a failed write
 * costs the host its classification, never the turn.
 */
import { getTaskSeriesId } from './db/session-routing.js';
import { getOutboundDb } from './mailbox/sqlite/connection.js';
import {
  registerPromptSectionContributor,
  registerProviderExchangeObserver,
  registerProviderMessageObserver,
  registerTurnRetryHandler,
} from './seam/index.js';

const REASON_MAX = 300;

const tableReady = new WeakSet<object>();
function ensureTable(db: ReturnType<typeof getOutboundDb>): void {
  if (tableReady.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_run_marks (
      message_id TEXT PRIMARY KEY,
      reached_at TEXT,
      outcome    TEXT,
      reason     TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  tableReady.add(db);
}

function inTaskSession(): boolean {
  try {
    return getTaskSeriesId() !== null;
  } catch {
    return false;
  }
}

/** Rows of the query that just started: everything this container holds in flight. */
let inFlight: string[] = [];

/** A query is starting: every row claimed right now reached the model. */
export function markQueryStart(): void {
  if (!inTaskSession()) return;
  try {
    const db = getOutboundDb();
    ensureTable(db);
    const ids = (
      db.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all() as Array<{
        message_id: string;
      }>
    ).map((r) => r.message_id);
    inFlight = ids;
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO task_run_marks (message_id, reached_at, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(message_id) DO UPDATE SET reached_at = COALESCE(reached_at, excluded.reached_at)',
    );
    for (const id of ids) insert.run(id, now, now);
  } catch {
    // Classification only — never disturb the query.
  }
}

/** Record how the in-flight rows' turn ended. */
export function markOutcome(outcome: 'ok' | 'error', reason: string | null): void {
  if (!inTaskSession() || inFlight.length === 0) return;
  try {
    const db = getOutboundDb();
    ensureTable(db);
    const now = new Date().toISOString();
    const update = db.prepare('UPDATE task_run_marks SET outcome = ?, reason = ?, updated_at = ? WHERE message_id = ?');
    const trimmed = reason ? reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : null;
    for (const id of inFlight) update.run(outcome, outcome === 'error' ? trimmed : null, now, id);
  } catch {
    // ignore — see markQueryStart
  }
}

/** A batch was claimed: create the table now, so the host can tell this runner writes marks. */
export function markBatchStart(): void {
  if (!inTaskSession()) return;
  try {
    ensureTable(getOutboundDb());
  } catch {
    // ignore — see markQueryStart
  }
}

registerProviderMessageObserver((ev) => {
  if (ev.kind === 'batch_start') markBatchStart();
  else if (ev.kind === 'turn_start') markQueryStart();
});

registerProviderExchangeObserver((exchange) => {
  markOutcome(exchange.status === 'error' ? 'error' : 'ok', exchange.result);
});

// Consulted for every failed turn, both shapes (an error result and a thrown
// query). Records the failure and declines, so a real retry handler still gets
// its turn and core's error path is unchanged.
registerTurnRetryHandler(async (ctx) => {
  markOutcome('error', ctx.failure.message);
  return null;
});

registerPromptSectionContributor(() => {
  if (!inTaskSession()) return null;
  return [
    '### When a task run fails',
    '',
    'If this run cannot do what the task asks — a source is down, access is missing, the result is wrong — record it before you finish: `ncl tasks fail --reason "<one line: what failed>"`. The run is logged as failed and the task owner is alerted, so you do not need to message them about the failure yourself.',
  ].join('\n');
});
