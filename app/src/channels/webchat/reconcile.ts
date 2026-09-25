/**
 * Webchat reconcile loop — recovers from a known race where the host's
 * delivery dispatcher logs "No adapter for channel type" for an instant,
 * marks an outbound chat message delivered, and the message never reaches
 * the WS broadcast or `webchat_messages` table.
 *
 * Symptom: PWA shows "agent thinking" indefinitely, the response is in the
 * agent's `outbound.db` and the inbound `delivered` table — but no row in
 * `webchat_messages`, no WS broadcast.
 *
 * The bug is in trunk (`src/index.ts`'s deliveryAdapter wrapper marks
 * messages delivered even when `getChannelAdapter()` returns undefined),
 * so a clean fix requires a trunk change. This watchdog is the skill-only
 * workaround: every RECONCILE_INTERVAL_MS, scan recent outbound messages
 * across all webchat sessions and replay any that have no corresponding
 * `webchat_messages` row.
 *
 * Idempotency: an in-memory Set tracks outbound message ids we've already
 * replayed (or seen the regular delivery cover). Bounded to ~1000 entries.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { openOutboundDb } from '../../session-db-access.js';

import { sessionKeyToThread, storeWebchatMessage } from './db.js';
import type { WebchatServer } from './server.js';

const RECONCILE_INTERVAL_MS = 7_000;
const RECENT_WINDOW_MS = 60_000; // only scan messages from the last minute
const GRACE_MS = 5_000; // give the regular delivery path this much time before we replay
const SEEN_BOUND = 1000; // cap the dedup memory
// Rows read per session per pass, newest first. Far more than a session writes
// in RECENT_WINDOW_MS; the window itself is applied in JS (see reconcileOnce).
const RECENT_ROWS = 200;

const seen = new Set<string>();
let timer: NodeJS.Timeout | null = null;

interface WebchatSessionRow {
  session_id: string;
  agent_group_id: string;
  agent_name: string;
  room_id: string;
  /** Session key: null (main), a topic thread id, or a per-member `<user>::<thread>` key. */
  thread_id: string | null;
}

interface OutboundRow {
  id: string;
  kind: string;
  channel_type: string | null;
  platform_id: string | null;
  content: string;
  timestamp: string;
}

interface WebchatMessageProbe {
  id: string;
}

export function startReconcileLoop(server: WebchatServer): void {
  if (timer) return; // already running — guard against double-setup
  timer = setInterval(() => {
    reconcileOnce(server).catch((err) => {
      log.warn('Webchat reconcile pass failed', { err: err instanceof Error ? err.message : String(err) });
    });
  }, RECONCILE_INTERVAL_MS);
}

export function stopReconcileLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  seen.clear();
}

async function reconcileOnce(server: WebchatServer): Promise<void> {
  const sessions = await listWebchatSessions();
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  for (const sess of sessions) {
    const outDbPath = path.join(DATA_DIR, 'v2-sessions', sess.agent_group_id, sess.session_id, 'outbound.db');
    if (!fs.existsSync(outDbPath)) continue;

    let outDb;
    try {
      outDb = openOutboundDb(sess.agent_group_id, sess.session_id);
    } catch {
      continue;
    }
    try {
      // Recent webchat-channel chat messages produced by the container. The
      // window is applied in JS, not SQL: containers stamp ISO timestamps
      // ('…T…Z') and a text comparison against datetime()'s '… …' form made
      // every row of the same UTC day "recent" — which, with `seen` emptied
      // by a restart, replayed the day's replies into the room on every boot.
      const rows = recentOutbound(
        outDb
          .prepare(
            `SELECT id, kind, channel_type, platform_id, content, timestamp
             FROM messages_out
             WHERE kind = 'chat' AND channel_type = 'webchat'
             ORDER BY seq DESC LIMIT ?`,
          )
          .all(RECENT_ROWS) as OutboundRow[],
        cutoff,
      );

      for (const { row: msg, tsMs } of rows) {
        if (seen.has(msg.id)) continue;
        // Give regular delivery a head start before we second-guess it.
        if (Date.now() - tsMs < GRACE_MS) continue;

        const roomId = msg.platform_id ?? sess.room_id;
        if (!roomId) continue;

        // Did the regular delivery path already store this in webchat_messages?
        // We match on (room, sender_type=agent, content prefix, timestamp band)
        // because webchat_messages doesn't carry the outbound message id.
        //
        // Text only. An outbound row's `files` is a list of names in the
        // session's outbox; the bytes are the adapter's to deliver, so a lost
        // attachment can't be rebuilt from this row.
        const text = parseTextFromContent(msg.content);
        if (text === null || text.length === 0) {
          seen.add(msg.id);
          continue;
        }

        const probe = await findStoredAgentMessage(roomId, text, tsMs);

        if (probe) {
          // Regular delivery covered it — just remember we've seen it.
          markSeen(msg.id);
          continue;
        }

        // Lost message: replay through the same path the adapter's deliver()
        // would have used. Stores in webchat_messages + broadcasts via WS.
        log.warn('Webchat reconcile: replaying lost agent message', {
          room: roomId,
          msgId: msg.id,
          sessionId: sess.session_id,
          agent: sess.agent_name,
        });
        // Use the session's actual agent name as the sender — reconcile
        // has the unambiguous mapping (one session = one agent), so we
        // skip the deliver-path's "most recently active" heuristic.
        const senderName = sess.agent_name || agentDisplayName();
        try {
          // Back into the thread the session answers in — a topic thread's
          // reply stored without one would land in the room's main thread.
          const threadId = await replayThread(sess, roomId);
          const stored = await storeWebchatMessage(roomId, senderName, 'agent', text, threadId);
          server.broadcast(roomId, { type: 'message', ...stored });
          markSeen(msg.id);
        } catch (err) {
          log.warn('Webchat reconcile: replay failed', {
            msgId: msg.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      outDb.close();
    }
  }
}

/**
 * Outbound timestamps are ISO ('2026-09-23T17:32:45.092Z') — the container
 * stamps them from JS. The space form ('2026-09-23 17:32:45', read as UTC) is
 * tolerated for rows an older runner may have left behind.
 */
export function parseOutboundTs(ts: string): number {
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  return Date.parse(/([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
}

/** Rows stamped at or after `cutoffMs`, oldest first. */
export function recentOutbound<T extends { timestamp: string }>(
  rows: T[],
  cutoffMs: number,
): Array<{ row: T; tsMs: number }> {
  return rows
    .map((row) => ({ row, tsMs: parseOutboundTs(row.timestamp) }))
    .filter((r) => !Number.isNaN(r.tsMs) && r.tsMs >= cutoffMs)
    .sort((a, b) => a.tsMs - b.tsMs);
}

/** The UI thread a session's replies belong in (see sessionKeyToThread). */
export function replayThread(sess: Pick<WebchatSessionRow, 'thread_id'>, roomId: string): Promise<string> {
  return sessionKeyToThread(sess.thread_id, roomId);
}

/** All webchat-channel sessions known to the central DB. */
async function listWebchatSessions(): Promise<WebchatSessionRow[]> {
  return (await getDb()
    .all(`SELECT s.id AS session_id, s.agent_group_id, ag.name AS agent_name, mg.platform_id AS room_id,
              s.thread_id
       FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
       JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       WHERE mg.channel_type = 'webchat'`)) as WebchatSessionRow[];
}

/**
 * Look for an agent-typed text row in webchat_messages whose content matches
 * the outbound text exactly, stored no earlier than 30 s before the agent
 * wrote it (clock drift) and at any time since. The upper bound used to be
 * +30 s, which read a reply delivered late — a session that synced after a
 * pause — as lost, and replayed it.
 */
async function findStoredAgentMessage(
  roomId: string,
  content: string,
  outboundTsMs: number,
): Promise<WebchatMessageProbe | undefined> {
  const lo = outboundTsMs - 30_000;
  const hi = Date.now() + 60_000;
  return (await getDb().get(
    `SELECT id FROM webchat_messages
       WHERE room_id = ? AND sender_type = 'agent' AND message_type = 'text'
         AND content = ?
         AND created_at BETWEEN ? AND ?
       LIMIT 1`,
    roomId,
    content,
    lo,
    hi,
  )) as WebchatMessageProbe | undefined;
}

function parseTextFromContent(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as { text?: unknown };
    return typeof obj.text === 'string' ? obj.text : null;
  } catch {
    return null;
  }
}

function agentDisplayName(): string {
  return process.env.AGENT_DISPLAY_NAME || 'Agent';
}

function markSeen(id: string): void {
  seen.add(id);
  if (seen.size > SEEN_BOUND) {
    // Drop oldest entries (Set preserves insertion order).
    const toDrop = seen.size - Math.floor(SEEN_BOUND * 0.8);
    let i = 0;
    for (const v of seen) {
      if (i++ >= toDrop) break;
      seen.delete(v);
    }
  }
}
