/**
 * Webchat status feed — fork-owned consumer of the provider message seam.
 *
 * Registers a provider-message observer that turns tool-use events into
 * `status_events` rows (the webchat thinking-bubble's live activity feed).
 * This file is the module side of the seam: provider code knows nothing about
 * the feed; it just notifies observers, and this observer writes the rows.
 * Loaded for side effects from the runner entry (index.ts).
 *
 * Best-effort by contract: a write failure must never break the tool call it
 * observes (the seam's notify wrapper also guarantees that).
 */
import { getOutboundDb } from './mailbox/sqlite/connection.js';
import { redactSecrets } from './formatter.js';
import { registerProviderMessageObserver } from './providers/hooks.js';

/**
 * Pull a short, human-meaningful target out of a tool's input for the feed —
 * the file a Read/Edit touches, the command Bash runs, the query a search
 * uses. Returns null when the tool has no salient target (the client then
 * shows just the tool verb). Host-side redaction scrubs secrets before any of
 * this reaches a client.
 */
export function summarizeToolTarget(toolName: string, input: Record<string, unknown> | undefined): string | null {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  switch (toolName) {
    case 'Bash':
      return str(input?.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str(input?.file_path) ?? str(input?.notebook_path);
    case 'Glob':
    case 'Grep':
      return str(input?.pattern);
    case 'WebFetch':
      return str(input?.url);
    case 'WebSearch':
      return str(input?.query);
    // pi's built-ins. Lowercase names and its own argument keys, so they miss
    // every case above and would otherwise render as a bare verb — "write"
    // with no hint of what was written.
    case 'read':
    case 'write':
    case 'edit':
      return str(input?.path) ?? str(input?.file_path);
    case 'bash':
      return str(input?.command) ?? str(input?.cmd);
    default:
      return null;
  }
}

registerProviderMessageObserver((ev) => {
  switch (ev.kind) {
    case 'tool_use':
      appendStatusEvent('tool', ev.toolName, summarizeToolTarget(ev.toolName, ev.toolInput));
      break;
    case 'batch_start':
      // Fresh batch accepted: reset the feed so the bubble shows only this
      // turn's events.
      clearStatusEvents();
      break;
    case 'turn_start':
      // A follow-up sub-turn inside a long-lived query cycles the feed: clear
      // the previous sub-turn's snapshot so the bubble doesn't freeze on it.
      if (ev.resetFeed) clearStatusEvents();
      appendStatusEvent('start', null);
      break;
    case 'turn_done':
      appendStatusEvent('done', null);
      break;
    case 'progress':
      appendStatusEvent('progress', ev.text);
      break;
    case 'reasoning':
      // `detail` (the full block) rides as an untyped extra field on the first
      // line's event — see the cast in claude.ts. Read it back the same way so
      // upstream's event type stays untouched.
      appendStatusEvent('reasoning', ev.text, (ev as { detail?: string }).detail ?? null);
      break;
  }
});

// ── The feed's own side-table ────────────────────────────────────────────────
// status_events: append-only UI activity feed for the "thinking" bubble.
// Declared via the outbound schema-extension seam — core schema stays
// untouched, and older session DBs pick the table up on their next open.
// The status_events table is created on first write (below) rather than at DB
// open — the reader (agent-status) already tolerates its absence, and creating
// it lazily means the seam does not need an outbound-schema hook in upstream's
// connection module. Idempotent: CREATE TABLE IF NOT EXISTS, guarded once.
// Keyed on the DB INSTANCE, not a boolean: initTestSessionDb() swaps in a fresh
// database, and a module-level flag would then skip creation on the new one and
// every read would hit "no such table".
const statusTableReady = new WeakSet<object>();
function ensureStatusTable(db: ReturnType<typeof getOutboundDb>): void {
  if (statusTableReady.has(db)) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS status_events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        text       TEXT,
        detail     TEXT,
        created_at TEXT NOT NULL
      );
`);
  statusTableReady.add(db);
}

/**
 * Max status_events rows to keep mid-turn. The host only needs rows past its
 * watermark and clearStatusEvents() wipes the table each turn, so this is just
 * a safety cap against a pathological single turn emitting thousands of events.
 */
const STATUS_EVENTS_CAP = 200;

/**
 * Append one activity event to the webchat thinking-bubble feed. Best-effort
 * and purely cosmetic — it must never throw into the caller (a missing table
 * on an older outbound.db, a locked write, etc. are all swallowed).
 *
 * `kind` is 'tool' | 'progress' | 'reasoning' | 'done'. For 'tool', `text` is
 * the tool name and `detail` is the target (file/command/query); for the
 * others `text` carries the message and `detail` is null.
 */
// Per-turn tool counter for the learning loop's auto-trigger. Counted here —
// the one chokepoint every provider's tool activity already flows through —
// so the poll-loop needs no per-provider wiring. 'start' resets it.
let turnToolCount = 0;
export function getTurnToolCount(): number {
  return turnToolCount;
}

export function appendStatusEvent(kind: string, text: string | null, detail: string | null = null): void {
  // Redact HERE, not at each call site. This is the one choke point every
  // provider's events pass through on the way to something a person can read
  // — the live bubble now, the durable feed next — and reasoning is where a
  // model most readily restates a token it just read. A missed call site
  // would put a secret somewhere it is kept.
  if (text !== null) text = redactSecrets(text);
  if (detail !== null) detail = redactSecrets(detail);
  if (kind === 'start') turnToolCount = 0;
  else if (kind === 'tool') turnToolCount++;
  try {
    const db = getOutboundDb();
    ensureStatusTable(db);
    db.prepare(`INSERT INTO status_events (kind, text, detail, created_at) VALUES ($kind, $text, $detail, $now)`).run({
      $kind: kind,
      $text: text,
      $detail: detail,
      $now: new Date().toISOString(),
    });
    // Trim everything older than the most recent CAP rows.
    db.prepare(`DELETE FROM status_events WHERE seq <= (SELECT MAX(seq) FROM status_events) - $cap`).run({
      $cap: STATUS_EVENTS_CAP,
    });
  } catch {
    // Cosmetic feed — never let it disrupt the turn.
  }
}

/**
 * Wipe the status feed at the start of a turn so it reflects only the current
 * turn's activity. Safe across turns: AUTOINCREMENT means the next row's seq is
 * still higher than the host's watermark, so nothing is missed or replayed.
 */
export function clearStatusEvents(): void {
  try {
    const db = getOutboundDb();
    ensureStatusTable(db);
    db.prepare(`DELETE FROM status_events`).run();
  } catch {
    // ignore — see appendStatusEvent
  }
}
