/**
 * Webchat reconcile loop. Trunk's deliveryAdapter wrapper can mark an outbound
 * message delivered while `getChannelAdapter()` transiently returns undefined,
 * so the reply never reaches `webchat_messages` or the WS and the PWA "thinks"
 * forever. Every RECONCILE_INTERVAL_MS this replays recent webchat outbound
 * messages that have no stored row. A bounded (~1000) in-memory Set of handled
 * ids keeps it idempotent.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { openInboundDb, openOutboundDb } from '../../session-db-access.js';

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
      // The window is applied in JS, not SQL: ISO stamps ('…T…Z') don't compare
      // as text against datetime()'s '… …' form.
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

      const settled = settledDeliveries(
        sess,
        rows.map((r) => r.row.id),
      );

      for (const { row: msg, tsMs } of rows) {
        if (seen.has(msg.id)) continue;
        // Give regular delivery a head start before we second-guess it.
        if (Date.now() - tsMs < GRACE_MS) continue;
        // Only second-guess a delivery trunk has finished. One still pending
        // or between retries — or in a deliver() slower than the grace period —
        // stores its own row; replaying it here would post the reply twice.
        if (!settled.has(msg.id)) continue;

        const roomId = msg.platform_id ?? sess.room_id;
        if (!roomId) continue;

        // Stored already? Matched on content + time band, as webchat_messages
        // has no outbound id. Text only: a lost attachment can't be rebuilt here.
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
        // One session = one agent, so no "most recently active" heuristic.
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

/** Outbound timestamps are ISO; the space form (read as UTC) is also accepted. */
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

/** The outbound ids trunk has marked delivered in this session's inbound.db. */
function settledDeliveries(sess: WebchatSessionRow, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  if (!fs.existsSync(path.join(DATA_DIR, 'v2-sessions', sess.agent_group_id, sess.session_id, 'inbound.db'))) {
    return new Set();
  }
  let db;
  try {
    db = openInboundDb(sess.agent_group_id, sess.session_id);
  } catch {
    return new Set();
  }
  try {
    return deliveredIds(db, ids);
  } finally {
    db.close();
  }
}

/** Of `ids`, those with a `delivered` row in status 'delivered' (not failed). */
export function deliveredIds(db: Pick<Database.Database, 'prepare'>, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db
    .prepare(
      `SELECT message_out_id FROM delivered
        WHERE status = 'delivered' AND message_out_id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as { message_out_id: string }[];
  return new Set(rows.map((r) => r.message_out_id));
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
 * An agent text row matching the outbound text exactly, stored no earlier
 * than 30 s before the agent wrote it (clock drift) and with no upper bound,
 * so a late delivery isn't mistaken for a lost one.
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
