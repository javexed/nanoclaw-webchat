// Session-DB access for the fork's modules, fork-owned.
//
// Upstream's session-manager used to export these by-session openers; its
// mailbox refactor moved raw access to mailbox/sqlite/session-db.ts (by path)
// and dropped the by-session wrappers. Several fork modules still need them —
// the status feed tails a session's outbound.db, per-user credential fan-out
// syncs a room's transcript into a member session's inbound.db. They live here
// so upstream's file stays untouched and the modules keep one import site.
import type Database from 'better-sqlite3';

import {
  migrateMessagesInTable,
  nextEvenSeq,
  openInboundDb as openInboundDbRaw,
  openOutboundDb as openOutboundDbRaw,
  openOutboundDbRw as openOutboundDbRwRaw,
} from './mailbox/sqlite/session-db.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { extractAttachmentFiles } from './session-manager.js';
import { updateSession } from './db/sessions.js';

export { inboundDbPath, outboundDbPath };

/** Open a session's inbound DB (host side; the host is its writer). */
export function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const db = openInboundDbRaw(inboundDbPath(agentGroupId, sessionId));
  migrateMessagesInTable(db);
  return db;
}

/** Open a session's inbound DB, run `fn`, and always close it. */
export function withInboundDb<T>(agentGroupId: string, sessionId: string, fn: (db: Database.Database) => T): T {
  const db = openInboundDb(agentGroupId, sessionId);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRaw(outboundDbPath(agentGroupId, sessionId));
}

/** Open the outbound DB for a session with write access. Only safe to call when no container is running. */
export function openOutboundDbRw(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRwRaw(outboundDbPath(agentGroupId, sessionId));
}

export interface ContextMessage {
  id: string;
  kind: string;
  timestamp: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
  trigger: 0 | 1;
}

export function syncSessionContext(agentGroupId: string, sessionId: string, messages: ContextMessage[]): void {
  if (messages.length === 0) return;
  const db = openInboundDb(agentGroupId, sessionId);
  try {
    const existing = new Set((db.prepare('SELECT id FROM messages_in').all() as { id: string }[]).map((r) => r.id));
    const insert = db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger, source_session_id, on_wake)
       VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content, NULL, NULL, @id, @trigger, NULL, 0)`,
    );
    for (const m of messages) {
      if (existing.has(m.id)) continue;
      // Context rows carry attachments too — the UserCreds fan-out replays a
      // room's file messages into a per-member session. Stage them exactly as
      // writeSessionMessage does; without this the bytes never reach the
      // container and the agent gets a message it cannot act on.
      const content = extractAttachmentFiles(agentGroupId, sessionId, m.id, m.content);
      insert.run({ ...m, content, seq: nextEvenSeq(db) });
    }
  } finally {
    db.close();
  }
  updateSession(sessionId, { last_active: new Date().toISOString() }).catch(() => {
    /* last_active is advisory */
  });
}
