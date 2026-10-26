/**
 * A revoke must reach sockets already open: a member whose access to a room is
 * taken away stays bound to it, and keeps receiving its messages, until the
 * room list is pushed again (broadcastRooms unbinds rooms that left the list).
 */
import type { ServerResponse } from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./state.js', () => ({ broadcastRooms: vi.fn(async () => {}) }));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { revokePermissionHandler } from './server/routes-users.js';
import { broadcastRooms } from './state.js';

const now = '2026-06-10T00:00:00.000Z';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  const db = getDb();
  await db.run(
    `INSERT INTO users (id, kind, display_name, created_at) VALUES ('webchat:bob', 'webchat', NULL, ?)`,
    now,
  );
  await db.run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1', 'a', 'a', NULL, ?)`,
    now,
  );
  await db.run(
    `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES ('webchat:bob', 'ag-1', NULL, ?)`,
    now,
  );
  vi.clearAllMocks();
});
afterEach(() => closeDb());

function fakeRes(): ServerResponse & { statusCode: number } {
  const res = { statusCode: 0, setHeader: () => {}, writeHead: (s: number) => (res.statusCode = s), end: () => {} };
  return res as unknown as ServerResponse & { statusCode: number };
}

describe('revoking access', () => {
  it('pushes fresh room lists so a socket on a lost room is unbound', async () => {
    const res = fakeRes();
    await revokePermissionHandler(res, { userId: 'webchat:bob', kind: 'member', agentGroupId: 'ag-1' });
    expect(res.statusCode).toBe(200);
    expect(broadcastRooms).toHaveBeenCalledTimes(1);
  });
});
