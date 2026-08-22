// ── Floor feed: what the desks are actually saying, right now ───────────────
//
// Phase 1 showed each desk's STATE. This adds the traffic: what an agent is
// thinking, the messages arriving, and the agent-to-agent edges that make the
// floor feel like a floor rather than a status page.
//
// IT TOUCHES NOTHING ON THE DELIVERY PATH. Every event here is already written
// to disk by the normal flow — `status_events` in a session's outbound DB, and
// `messages_in` rows (with `source_session_id` set for an a2a hop) in its
// inbound DB. So this is a SECOND READER of durable rows, never a second
// writer and never an interception. The architecture's one-writer-per-file rule
// is about writers; an extra read-only reader is exactly what it permits.
//
// Consequences of that choice, which are the point of it:
//   - Delivery keeps its own per-session watermark; this keeps none at all
//     (see the cursor note below). Nothing is shared, so this cannot make
//     delivery skip, replay, or block.
//   - Every read is wrapped. A missing table, a half-written DB, a session
//     whose container never opened one — all degrade to "no events", never to
//     an exception on a cosmetic view.
//   - Switching the feed off changes nothing else. It is additive.
//
// CURSOR. Events come from many DBs, so there is no single sequence to count.
// Each event carries its own ISO timestamp, and the client sends back the
// newest it has seen; the server returns what is newer, capped. That keeps the
// server stateless — two admins watching the floor do not interfere, and a
// reconnecting client resumes without the server remembering it.
import fs from 'fs';

import { isContainerRunning } from '../../../container-runner.js';
import { getMessagingGroup } from '../../../db/messaging-groups.js';
import { hasAdminPrivilege } from '../roles.js';
import { getDb } from '../../../db/connection.js';
import { inboundDbPath, outboundDbPath, openOutboundDb, openInboundDb } from '../../../session-manager.js';
import { redactSensitiveData } from '../redact.js';
import { agentNameFor, roomFor, type SessionRow } from './floor.js';

/** One thing that happened at a desk. */
export interface FloorEvent {
  at: string; // ISO — also the cursor
  session_id: string;
  agent_name: string;
  room_id: string | null;
  /** 'thinking' | 'tool' | 'message' | 'a2a' — what the UI draws. */
  kind: 'thinking' | 'tool' | 'message' | 'a2a';
  /** Redacted and truncated. Never a full transcript. */
  text: string | null;
  /** For an a2a hop: the session that SENT it, so the UI can draw the edge. */
  from_session_id?: string;
}

/**
 * How much of any text crosses this boundary.
 *
 * The room feed shows a room's own members their own room. This is
 * install-wide: one admin sees fragments of every conversation. Redaction
 * (the same pass the room feed uses) removes secrets; this cap is a separate
 * decision about VOLUME — a floor wants a glimpse that says "it is working on
 * the deploy script", not the script. Short enough that the view cannot quietly
 * become a transcript reader.
 */
const TEXT_CAP = 120;

/** Never let one slow tick return an unbounded page. */
const MAX_EVENTS = 200;

/** How far behind the client's cursor each poll re-reads (client dedupes). */
const OVERLAP_MS = 5_000;

/**
 * How far back a client with no cursor starts. Long enough that opening the
 * floor shows something rather than an empty room; short enough that it is not
 * a history browser.
 */
const COLD_START_MS = 2 * 60 * 1000;

export function clip(s: string | null | undefined): string | null {
  if (!s) return null;
  // Redact FIRST — truncate-then-redact would leave half a key in place.
  const red = redactSensitiveData(String(s));
  if (red.length <= TEXT_CAP) return red;
  // Code-point slice, not string slice: a UTF-16 cut can split a surrogate
  // pair and ship a lone surrogate in the JSON payload.
  return [...red].slice(0, TEXT_CAP - 1).join('') + '…';
}

/** status_events → thinking/tool. Read-only, and silent when absent. */
function readStatus(
  agentGroupId: string,
  sessionId: string,
  sinceIso: string,
): Array<{ at: string; kind: string; text: string | null }> {
  let db;
  try {
    // Guard like the inbound reader: opening would CREATE a missing DB, and
    // the host must never mint container-side files for a cold session.
    if (!fs.existsSync(outboundDbPath(agentGroupId, sessionId))) return [];
    db = openOutboundDb(agentGroupId, sessionId);
    return db
      .prepare(
        `SELECT created_at AS at, kind, text
           FROM status_events
          WHERE created_at > ?
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(sinceIso, MAX_EVENTS) as Array<{ at: string; kind: string; text: string | null }>;
  } catch {
    return [];
  } finally {
    // Session DBs are open-read-close per op by contract; a 5s poll that held
    // handles open would accumulate fds until GC and starve OTHER host paths.
    try {
      db?.close();
    } catch {}
  }
}

/**
 * messages_in → message arrivals and a2a hops.
 *
 * `source_session_id` is the a2a marker: it is set when one agent's turn routed
 * a message to another agent's session, and null for anything that came from a
 * human on a channel. That single column is what lets the UI draw an edge
 * between two desks without any new instrumentation.
 */
function readInbound(
  agentGroupId: string,
  sessionId: string,
  sinceIso: string,
): Array<{ at: string; content: string | null; source_session_id: string | null }> {
  let db;
  try {
    // Skip a session whose inbound DB has not been created yet rather than
    // letting openInboundDb create or fail on it.
    if (!fs.existsSync(inboundDbPath(agentGroupId, sessionId))) return [];
    db = openInboundDb(agentGroupId, sessionId);
    // kind='chat' AND trigger=1: control rows (interrupts, tasks) are not
    // conversation, and trigger-0 rows are fan-out echoes — one room message
    // is copied into every sibling session, which would show once per desk.
    return db
      .prepare(
        `SELECT timestamp AS at, content, source_session_id
           FROM messages_in
          WHERE timestamp > ? AND kind = 'chat' AND trigger = 1
          ORDER BY timestamp ASC
          LIMIT ?`,
      )
      .all(sinceIso, MAX_EVENTS) as Array<{ at: string; content: string | null; source_session_id: string | null }>;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * A message row's content is a JSON envelope in most paths and bare text in
 * some. Pull out something human before clipping, and never throw on a shape
 * this did not expect.
 */
export function messageText(content: string | null): string | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'string') return parsed;
    return parsed?.text ?? parsed?.prompt ?? parsed?.body ?? null;
  } catch {
    return content;
  }
}

/**
 * A session is worth reading for this long after its last activity even when
 * its container is not (yet) running. The message that WAKES a cold session is
 * written BEFORE the container exists — skip cold sessions outright and that
 * arrival lands behind an already-advanced cursor, invisible forever. Ten
 * minutes comfortably covers spawn time while keeping the per-tick cost
 * bounded by recent activity, not by how many sessions have ever existed.
 */
export const ACTIVE_GRACE_MS = 10 * 60 * 1000;

/**
 * Whether a session's DBs are worth opening this tick: its container is
 * running, or it was active recently enough that a cold-spawn arrival may not
 * have been reported yet. Pure, because the cold-spawn miss shipped once
 * already and this predicate is the whole fix.
 */
export function deskEligible(running: boolean, lastActiveIso: string | null, nowMs: number): boolean {
  if (running) return true;
  if (!lastActiveIso) return false;
  const t = Date.parse(lastActiveIso);
  if (Number.isNaN(t)) return false;
  return nowMs - t < ACTIVE_GRACE_MS;
}

/**
 * Events newer than `sinceIso`, for the sessions this caller may see.
 *
 * Status events are only read from RUNNING containers (a cold session has no
 * live status by definition); message arrivals also come from recently-active
 * sessions, per deskEligible above.
 */
export async function readFloorEvents(
  userId: string,
  sinceIso?: string,
): Promise<{ events: FloorEvent[]; cursor: string }> {
  const db = getDb();
  // Re-read a small window BEHIND the cursor: rows can commit mid-scan with
  // timestamps older than the advanced cursor (the scan awaits between
  // sessions), platform timestamps can lag write time, and same-millisecond
  // ties across DBs have no tiebreaker. The client dedupes, so overlap costs
  // nothing; without it those events are skipped forever.
  const since =
    sinceIso && !Number.isNaN(Date.parse(sinceIso))
      ? new Date(Date.parse(sinceIso) - OVERLAP_MS).toISOString()
      : new Date(Date.now() - COLD_START_MS).toISOString();

  const rows = (await db.all(
    "SELECT id, agent_group_id, messaging_group_id, last_active FROM sessions WHERE status = 'active'",
  )) as SessionRow[];
  const out: FloorEvent[] = [];

  for (const row of rows) {
    const running = isContainerRunning(row.id);
    if (!deskEligible(running, row.last_active, Date.now())) continue;
    // Content gate is ADMIN-level, deliberately stricter than the desks: feed
    // fragments cross room boundaries within an agent group, so mere group
    // membership must not reveal other rooms' (or other members' DM) traffic.
    if (!(await hasAdminPrivilege(userId, row.agent_group_id))) continue;

    const mg = await (row.messaging_group_id ? getMessagingGroup(row.messaging_group_id) : undefined);
    // roomFor is the pinned platform-id/row-id distinction — do not re-inline it.
    const { roomId } = roomFor(mg);
    const name = await agentNameFor(db, row.agent_group_id);

    for (const e of readStatus(row.agent_group_id, row.id, since)) {
      // Allowlist, not blocklist: only tool/reasoning/progress become feed
      // lines. Everything else — start, done, stalled, and any future kind —
      // is state the desk colour already shows, and drops here by default.
      if (e.kind !== 'tool' && e.kind !== 'reasoning' && e.kind !== 'progress') continue;
      out.push({
        at: e.at,
        session_id: row.id,
        agent_name: name,
        room_id: roomId,
        kind: e.kind === 'tool' ? 'tool' : 'thinking',
        text: clip(e.text),
      });
    }

    for (const m of readInbound(row.agent_group_id, row.id, since)) {
      out.push({
        at: m.at,
        session_id: row.id,
        agent_name: name,
        room_id: roomId,
        kind: m.source_session_id ? 'a2a' : 'message',
        text: clip(messageText(m.content)),
        ...(m.source_session_id ? { from_session_id: m.source_session_id } : {}),
      });
    }
  }

  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  // Keep the OLDEST page and advance the cursor only to the last KEPT event:
  // a burst larger than the cap is then delivered across successive ticks
  // instead of silently losing its head (slice(-MAX) + newest-cursor skipped
  // the dropped older events forever).
  const events = out.slice(0, MAX_EVENTS);
  // Advance the cursor even when nothing came back, or a quiet floor would
  // re-scan the same window forever.
  const cursor = events.length ? events[events.length - 1]!.at : new Date().toISOString();
  return { events, cursor };
}
