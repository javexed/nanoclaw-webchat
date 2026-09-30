/**
 * Room humans -> session DB, so an agent can reach a PERSON.
 *
 * An agent knows only its `destinations`, so asked for a human it addresses
 * the nearest agent instead. Webchat already turns `@handle` mentions on every
 * message, agent-authored ones included, into a badge + push (broadcast() in
 * state.ts); this writes the room's handles into inbound.db at spawn, like
 * `destinations`, and the runner renders them into the prompt.
 *
 * Scoped to the ROOM, not the user table: everyone listed can already read the
 * room, so naming them to its agent leaks nothing new. A global list would.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { inboundDbPath } from '../../session-db-access.js';
import { log } from '../../log.js';

export interface RoomHuman {
  user_id: string;
  handle: string;
  display_name: string | null;
}

/**
 * Humans who have actually spoken in this room and own an @-handle.
 *
 * "Has spoken" rather than "has access": a mention is only useful for someone
 * who reads the room, and it keeps the list short enough to be worth putting in
 * a system prompt. Agent and side-channel rows are excluded — `sender_type`
 * 'user' is the only one that denotes a person.
 */
export async function getRoomHumans(roomId: string): Promise<RoomHuman[]> {
  return (await getDb().all(
    `SELECT DISTINCT h.user_id AS user_id, h.handle AS handle, u.display_name AS display_name
         FROM webchat_user_handles h
         JOIN webchat_messages m ON m.sender = h.user_id AND m.room_id = ? AND m.sender_type = 'user'
         LEFT JOIN users u ON u.id = h.user_id
        ORDER BY h.handle`,
    roomId,
  )) as RoomHuman[];
}

/**
 * Materialize the room's humans into the session's inbound.db. Mirrors
 * writeDestinations: refreshed on every spawn, so a newly-joined person becomes
 * mentionable on the next wake rather than needing a restart.
 */
export async function writeRoomHumans(agentGroupId: string, sessionId: string): Promise<void> {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const session = await getSession(sessionId);
  if (!session?.messaging_group_id) return;
  const mg = await getMessagingGroup(session.messaging_group_id);
  // Webchat-only: @-handles are a webchat concept. Other channels have their
  // own mention syntax and are left alone.
  if (!mg || mg.channel_type !== 'webchat') return;

  let humans: RoomHuman[];
  try {
    humans = await getRoomHumans(mg.platform_id);
  } catch (err) {
    // Handles table absent (older install) — nothing to publish, never fatal.
    log.debug('room humans lookup skipped', { err: err instanceof Error ? err.message : err });
    return;
  }

  const db = new Database(dbPath);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS room_humans (
         user_id TEXT PRIMARY KEY,
         handle TEXT NOT NULL,
         display_name TEXT
       )`,
    );
    const replace = db.transaction((rows: RoomHuman[]) => {
      db.prepare('DELETE FROM room_humans').run();
      const insert = db.prepare('INSERT INTO room_humans (user_id, handle, display_name) VALUES (?, ?, ?)');
      for (const r of rows) insert.run(r.user_id, r.handle, r.display_name);
    });
    replace(humans);
  } finally {
    db.close();
  }
}
