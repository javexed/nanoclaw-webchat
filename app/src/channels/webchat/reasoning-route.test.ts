import { ServerResponse } from 'http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createWebchatRoom, recordActivity } from './db.js';
import { rRoomReasoningGet } from './server/routes-rooms.js';
import type { RouteCtx } from './server.js';

/**
 * The live bubble only ever holds the CURRENT turn — the container wipes
 * status_events each turn — so click-to-expand on an older turn had nothing to
 * show. This route is what gives it the untruncated block back, and the room
 * guard is the reason it can't just read the table directly from the client.
 */

let status = 0;
let body: unknown;

function ctx(userId: string): RouteCtx {
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(payload?: string) {
      body = payload ? JSON.parse(payload) : undefined;
    },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, userId } as unknown as RouteCtx;
}

const NOW = '2026-06-10T00:00:00.000Z';

/** A room is only reachable through an agent wired to it, and only by someone
 *  with rights to that agent group — so the fixture has to build the whole
 *  chain. The 403 this avoids is the guard working, not a test detail. */
async function wireRoom(roomId: string, agentGroupId: string): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    agentGroupId,
    agentGroupId,
    agentGroupId,
    NOW,
  );
  const mg = (await db.get(`SELECT id FROM messaging_groups WHERE platform_id = ?`, roomId)) as
    | { id: string }
    | undefined;
  await db.run(
    `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
     VALUES (?, ?, ?, 'always', 'all', 'ignore', 'shared', 0, ?)`,
    `w-${roomId}`,
    mg!.id,
    agentGroupId,
    NOW,
  );
}

async function owner(userId: string): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`,
    userId,
    NOW,
  );
  await db.run(
    `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`,
    userId,
    NOW,
  );
}

beforeEach(async () => {
  status = 0;
  body = undefined;
  await initTestDb();
  await runMigrations(getDb());
  await createWebchatRoom('Gardens', 'gardens');
  await wireRoom('gardens', 'ag-1');
  await owner('u1');
});
afterEach(() => closeDb());

describe('GET /api/rooms/:id/reasoning', () => {
  it('returns the FULL block, not the clipped ticker line', async () => {
    await recordActivity({
      roomId: 'gardens',
      agentName: 'AG',
      kind: 'reasoning',
      text: 'clipped first line',
      detail: 'the whole\nuntruncated\ntrace',
      createdAt: Date.now(),
    });

    await rRoomReasoningGet(ctx('u1'), ['', 'gardens'] as unknown as RegExpMatchArray);

    expect(status).toBe(200);
    const rows = body as { text: string; agent_name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('the whole\nuntruncated\ntrace');
    expect(rows[0]!.agent_name).toBe('AG');
  });

  it('omits reasoning rows with no full block, and other kinds entirely', async () => {
    const t = Date.now();
    await recordActivity({
      roomId: 'gardens',
      agentName: null,
      kind: 'reasoning',
      text: 'clip',
      detail: null,
      createdAt: t,
    });
    await recordActivity({
      roomId: 'gardens',
      agentName: null,
      kind: 'tool',
      text: 'Bash',
      detail: 'ls',
      createdAt: t + 1,
    });

    await rRoomReasoningGet(ctx('u1'), ['', 'gardens'] as unknown as RegExpMatchArray);

    expect(status).toBe(200);
    expect(body as unknown[]).toHaveLength(0);
  });

  it('404s an unknown room rather than leaking that it does not exist differently', async () => {
    await rRoomReasoningGet(ctx('u1'), ['', 'nope'] as unknown as RegExpMatchArray);
    expect(status).toBe(404);
  });

  it('scopes to the room asked for', async () => {
    const t = Date.now();
    await createWebchatRoom('Excavating', 'excavating');
    await wireRoom('excavating', 'ag-1');
    await recordActivity({
      roomId: 'excavating',
      agentName: null,
      kind: 'reasoning',
      text: 'x',
      detail: 'other room',
      createdAt: t,
    });

    await rRoomReasoningGet(ctx('u1'), ['', 'gardens'] as unknown as RegExpMatchArray);
    expect(body as unknown[]).toHaveLength(0);
  });
});
