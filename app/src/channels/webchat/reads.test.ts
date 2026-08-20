/**
 * Tests for the per-user read-marker helpers that back the unread badge.
 *
 * Before this feature unread was a purely client-side, in-memory Set, so a
 * message that arrived while the user was away left no trace on reconnect.
 * These tests pin the server-side semantics that fix that:
 *
 *   - markRoomRead is a monotonic high-water mark (never moves backward).
 *   - getUnreadRoomIdsForUser flags a room iff its newest message is newer
 *     than the user's marker — per-user, and strictly newer at the boundary.
 *   - the marker cascades away with the room (clearReadsForRoom / delete).
 *   - annotateRoomsForUser surfaces the per-user `unread` flag in the rooms
 *     payload (the thing that lets the badge reconstruct on reconnect).
 */
import { randomUUID } from 'crypto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { annotateRoomsForUser } from './state.js';
import { clearReadsForRoom, deleteWebchatRoom, getUnreadRoomIdsForUser, markRoomRead } from './db.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  closeDb();
});

// ── Seed helpers (mirrors access.test.ts) ──

async function insertUser(userId: string): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`, userId, new Date().toISOString());
}

async function insertAgentGroup(id: string): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`, id, id, id, new Date().toISOString());
}

async function insertRoom(roomId: string, name = roomId): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'webchat', 'webchat', ?, ?, 0, 'public', ?)`, roomId, roomId, name, new Date().toISOString());
}

async function wire(roomId: string, agentGroupId: string): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`, randomUUID(), roomId, agentGroupId, new Date().toISOString());
}

async function grantOwner(userId: string): Promise<void> {
  insertUser(userId);
  await getDb().run(`INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, 'owner', NULL, NULL, ?)`, userId, new Date().toISOString());
}

/** Insert a message with an explicit created_at so unread-vs-marker is deterministic. */
async function insertMessage(roomId: string, createdAt: number): Promise<void> {
  await getDb().run(`INSERT INTO webchat_messages (id, room_id, sender, content, created_at)
       VALUES (?, ?, 'someone', 'hi', ?)`, randomUUID(), roomId, createdAt);
}

describe('markRoomRead', () => {
  it('marks a room with unseen messages as read', async () => {
    insertMessage('room-1', 1000);
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(true);
    markRoomRead('webchat:alice', 'room-1', 1000);
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
  });

  it('is monotonic — a later call with an older ts does not move the marker backward', async () => {
    insertMessage('room-1', 1800);
    markRoomRead('webchat:alice', 'room-1', 2000); // marker ahead of the message → read
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
    // A stale read (e.g. a backgrounded tab catching up) must NOT lower the
    // marker to 1500 — that would re-expose the 1800 message as unread.
    markRoomRead('webchat:alice', 'room-1', 1500);
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
  });

  it('advances forward when a newer ts arrives', async () => {
    insertMessage('room-1', 2000);
    markRoomRead('webchat:alice', 'room-1', 1000); // behind the message → still unread
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(true);
    markRoomRead('webchat:alice', 'room-1', 3000); // ahead of the message → read
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
  });
});

describe('getUnreadRoomIdsForUser', () => {
  it('a room with messages and no marker is unread (the away-and-return case)', async () => {
    insertMessage('room-1', 1000);
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(true);
  });

  it('a marker older than the newest message → unread', async () => {
    insertMessage('room-1', 1000);
    insertMessage('room-1', 3000);
    markRoomRead('webchat:alice', 'room-1', 2000); // between the two messages
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(true);
  });

  it('a marker at the newest message timestamp → read (boundary is strict >)', async () => {
    insertMessage('room-1', 1000);
    markRoomRead('webchat:alice', 'room-1', 1000);
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
  });

  it('a new message after reading makes the room unread again', async () => {
    insertMessage('room-1', 1000);
    markRoomRead('webchat:alice', 'room-1', 1000);
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
    insertMessage('room-1', 2000);
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(true);
  });

  it('a room with no messages is never unread', async () => {
    markRoomRead('webchat:alice', 'empty-room', 1000);
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('empty-room')).toBe(false);
  });

  it('is per-user — alice reading does not clear bob', async () => {
    insertMessage('room-1', 1000);
    markRoomRead('webchat:alice', 'room-1', 1000);
    expect((await getUnreadRoomIdsForUser('webchat:alice')).has('room-1')).toBe(false);
    expect((await getUnreadRoomIdsForUser('webchat:bob')).has('room-1')).toBe(true);
  });

  it('returns only the rooms newer than the marker (per-room resolution)', async () => {
    insertMessage('room-read', 1000);
    insertMessage('room-unread', 1000);
    markRoomRead('webchat:alice', 'room-read', 1000);
    const unread = await getUnreadRoomIdsForUser('webchat:alice');
    expect(unread.has('room-read')).toBe(false);
    expect(unread.has('room-unread')).toBe(true);
  });
});

describe('cascade on room delete', () => {
  it('clearReadsForRoom drops markers for that room only', async () => {
    markRoomRead('webchat:alice', 'room-1', 1000);
    markRoomRead('webchat:bob', 'room-1', 1000);
    markRoomRead('webchat:alice', 'room-2', 1000);
    clearReadsForRoom('room-1');
    const rows = (await getDb().all(`SELECT room_id FROM webchat_room_reads`)) as { room_id: string }[];
    expect(rows.map((r) => r.room_id)).toEqual(['room-2']);
  });

  it('deleteWebchatRoom clears the room’s read markers', async () => {
    insertRoom('room-1');
    markRoomRead('webchat:alice', 'room-1', 1000);
    deleteWebchatRoom('room-1');
    const rows = await getDb().all(`SELECT 1 FROM webchat_room_reads WHERE room_id = 'room-1'`);
    expect(rows).toEqual([]);
  });
});

describe('annotateRoomsForUser — unread flag', () => {
  it('flags an accessible room with unseen messages as unread', async () => {
    grantOwner('webchat:owner');
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    insertMessage('room-1', 1000);

    const rooms = await annotateRoomsForUser('webchat:owner');
    const room = rooms.find((r) => r.id === 'room-1');
    expect(room?.unread).toBe(true);
  });

  it('clears the unread flag once the marker advances', async () => {
    grantOwner('webchat:owner');
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    insertMessage('room-1', 1000);
    markRoomRead('webchat:owner', 'room-1', 1000);

    const room = (await annotateRoomsForUser('webchat:owner')).find((r) => r.id === 'room-1');
    expect(room?.unread).toBe(false);
  });

  it('is per-user — one user reading does not clear another’s badge', async () => {
    grantOwner('webchat:owner');
    grantOwner('webchat:owner2');
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    insertMessage('room-1', 1000);
    markRoomRead('webchat:owner', 'room-1', 1000);

    expect((await annotateRoomsForUser('webchat:owner')).find((r) => r.id === 'room-1')?.unread).toBe(false);
    expect((await annotateRoomsForUser('webchat:owner2')).find((r) => r.id === 'room-1')?.unread).toBe(true);
  });

  it('does not surface a room the user cannot access (so it can never be falsely unread)', async () => {
    grantOwner('webchat:owner');
    insertAgentGroup('ag-1');
    insertRoom('room-1');
    wire('room-1', 'ag-1');
    insertMessage('room-1', 1000);
    // A different user with no roles/access at all.
    insertUser('webchat:tailscale:stranger@example.com');

    const rooms = await annotateRoomsForUser('webchat:tailscale:stranger@example.com');
    expect(rooms.find((r) => r.id === 'room-1')).toBeUndefined();
  });
});
