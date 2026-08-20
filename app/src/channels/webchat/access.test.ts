/**
 * Tests for per-room access control.
 *
 * These gate every read/write surface that exposes room contents — bugs
 * here let users see or send into rooms they don't have access to.
 */
import { randomUUID } from 'crypto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { canAccessRoom, filterRoomsForUser } from './access.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  await closeDb();
});

async function insertUser(userId: string): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`,
    userId,
    new Date().toISOString(),
  );
}

async function insertAgentGroup(id: string): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    id,
    id,
    id,
    new Date().toISOString(),
  );
}

async function insertRoom(roomId: string, name = roomId): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'webchat', 'webchat', ?, ?, 0, 'public', ?)`,
    roomId,
    roomId,
    name,
    new Date().toISOString(),
  );
}

async function wire(roomId: string, agentGroupId: string): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`,
    randomUUID(),
    roomId,
    agentGroupId,
    new Date().toISOString(),
  );
}

async function grantRole(
  userId: string,
  role: 'owner' | 'admin' | 'member',
  agentGroupId: string | null,
): Promise<void> {
  await insertUser(userId);
  if (role === 'member') {
    if (!agentGroupId) throw new Error('member role requires agentGroupId');
    await getDb().run(
      `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
      userId,
      agentGroupId,
      new Date().toISOString(),
    );
    return;
  }
  await getDb().run(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, ?, ?, NULL, ?)`,
    userId,
    role,
    agentGroupId,
    new Date().toISOString(),
  );
}

describe('canAccessRoom', () => {
  it('returns false for an unknown user', async () => {
    await insertAgentGroup('ag-1');
    await insertRoom('room-1');
    await wire('room-1', 'ag-1');
    expect(await canAccessRoom('webchat:tailscale:nobody@example.com', 'room-1')).toBe(false);
  });

  it('returns false for a room with no wired agents', async () => {
    await grantRole('webchat:owner', 'owner', null);
    await insertRoom('orphan-room');
    expect(await canAccessRoom('webchat:owner', 'orphan-room')).toBe(false);
  });

  it('grants the global owner access to every room', async () => {
    await grantRole('webchat:owner', 'owner', null);
    await insertAgentGroup('ag-1');
    await insertRoom('room-1');
    await wire('room-1', 'ag-1');
    expect(await canAccessRoom('webchat:owner', 'room-1')).toBe(true);
  });

  it('grants a scoped admin access to rooms wired to their agent', async () => {
    await insertAgentGroup('ag-mine');
    await insertAgentGroup('ag-other');
    await insertRoom('room-mine');
    await insertRoom('room-other');
    await wire('room-mine', 'ag-mine');
    await wire('room-other', 'ag-other');
    await grantRole('webchat:admin', 'admin', 'ag-mine');
    expect(await canAccessRoom('webchat:admin', 'room-mine')).toBe(true);
    expect(await canAccessRoom('webchat:admin', 'room-other')).toBe(false);
  });

  it('grants a member access via agent_group_members', async () => {
    await insertAgentGroup('ag-1');
    await insertRoom('room-1');
    await wire('room-1', 'ag-1');
    await grantRole('webchat:member', 'member', 'ag-1');
    expect(await canAccessRoom('webchat:member', 'room-1')).toBe(true);
  });

  it('grants access to a multi-agent room if the user can reach any one agent', async () => {
    await insertAgentGroup('ag-mine');
    await insertAgentGroup('ag-other');
    await insertRoom('shared-room');
    await wire('shared-room', 'ag-mine');
    await wire('shared-room', 'ag-other');
    await grantRole('webchat:admin', 'admin', 'ag-mine');
    expect(await canAccessRoom('webchat:admin', 'shared-room')).toBe(true);
  });
});

describe('filterRoomsForUser', () => {
  it('only returns rooms the user can access', async () => {
    await insertAgentGroup('ag-mine');
    await insertAgentGroup('ag-other');
    await insertRoom('room-mine', 'Mine');
    await insertRoom('room-other', 'Other');
    await wire('room-mine', 'ag-mine');
    await wire('room-other', 'ag-other');
    await grantRole('webchat:admin', 'admin', 'ag-mine');

    const now = Date.now();
    const all = [
      { id: 'room-mine', name: 'Mine', created_at: now },
      { id: 'room-other', name: 'Other', created_at: now },
    ];
    expect(await filterRoomsForUser('webchat:admin', all)).toEqual([
      { id: 'room-mine', name: 'Mine', created_at: now },
    ]);
  });
});
