/**
 * GET /api/messages/:id/trace reads with the same gate as the room's history,
 * and the owner's recording settings validate what they store.
 */
import { ServerResponse } from 'http';
import { Readable } from 'stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';

import { createWebchatRoom, getTurnTraceDays, getTurnTracesEnabled, storeWebchatMessage } from './db.js';
import { rMessageTraceGet, rTurnTracesPut } from './server/routes-traces.js';
import type { RouteCtx } from './server.js';
import { recordStatusEvent, recordTurnMessage, resetActiveTraces } from './turn-traces.js';

const NOW = new Date().toISOString();
let status = 0;
let body: any;

function ctx(userId: string, reqBody?: unknown): RouteCtx {
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
  const req = Readable.from(reqBody === undefined ? [] : [Buffer.from(JSON.stringify(reqBody))]);
  return { req, res, userId } as unknown as RouteCtx;
}

async function wire(roomId: string, agentGroupId: string): Promise<string> {
  const db = getDb();
  await db.run(
    `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    agentGroupId,
    agentGroupId,
    agentGroupId,
    NOW,
  );
  const mg = (await db.get(`SELECT id FROM messaging_groups WHERE platform_id = ?`, roomId)) as { id: string };
  await db.run(
    `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
     VALUES (?, ?, ?, 'always', 'all', 'ignore', 'shared', 0, ?)`,
    `w-${roomId}`,
    mg.id,
    agentGroupId,
    NOW,
  );
  return mg.id;
}

async function user(
  id: string,
  role?: { role: string; agentGroupId: string | null },
  memberOf?: string,
): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`,
    id,
    NOW,
  );
  if (role)
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)`,
      id,
      role.role,
      role.agentGroupId,
      NOW,
    );
  if (memberOf)
    await db.run(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
      id,
      memberOf,
      NOW,
    );
}

let anchor: string;
let plain: string;

beforeEach(async () => {
  status = 0;
  body = undefined;
  resetActiveTraces();
  await initTestDb();
  await runMigrations(getDb());
  await createWebchatRoom('Gardens', 'gardens');
  const mgId = await wire('gardens', 'ag-1');
  await createWebchatRoom('Excavating', 'excavating');
  await wire('excavating', 'ag-2');
  await user('owner', { role: 'owner', agentGroupId: null });
  await user('gardener', undefined, 'ag-1');
  await user('digger', undefined, 'ag-2');

  const session = { id: 's1', agent_group_id: 'ag-1', messaging_group_id: mgId, thread_id: null } as Session;
  const at = () => new Date().toISOString();
  await recordStatusEvent(session, { kind: 'start', text: null, detail: null, createdAt: at() });
  await recordStatusEvent(session, { kind: 'tool', text: 'Read', detail: 'notes.md', createdAt: at() });
  anchor = (await storeWebchatMessage('gardens', 'ag-1', 'agent', 'done reading')).id;
  await recordTurnMessage('s1', anchor, null);
  await recordStatusEvent(session, { kind: 'done', text: null, detail: null, createdAt: at() });
  plain = (await storeWebchatMessage('gardens', 'gardener', 'user', 'thanks')).id;
});
afterEach(async () => {
  await closeDb();
});

const trace = (userId: string, id: string) => rMessageTraceGet(ctx(userId), ['', id] as unknown as RegExpMatchArray);

describe('GET /api/messages/:id/trace', () => {
  it("returns the trace to a member of the message's room", async () => {
    await trace('gardener', anchor);
    expect(status).toBe(200);
    expect(body.message_id).toBe(anchor);
    expect(body.trace.tools[0]).toMatchObject({ name: 'Read', target: 'notes.md' });
  });

  it('refuses a member of another room, even though the message exists', async () => {
    await trace('digger', anchor);
    expect(status).toBe(403);
    expect(body.trace).toBeUndefined();
  });

  it('404s a message with no trace and an unknown message', async () => {
    await trace('gardener', plain);
    expect(status).toBe(404);
    await trace('gardener', 'no-such-message');
    expect(status).toBe(404);
  });
});

describe('PUT /api/webchat/turn-traces', () => {
  const put = (b: unknown) => rTurnTracesPut(ctx('owner', b), [''] as unknown as RegExpMatchArray);

  it('defaults to on, 90 days, and stores a change', async () => {
    expect(await getTurnTracesEnabled()).toBe(true);
    expect(await getTurnTraceDays()).toBe(90);
    await put({ enabled: false, days: 30 });
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: false, days: 30 });
    expect(await getTurnTracesEnabled()).toBe(false);
  });

  it('rejects a bad value and stores nothing', async () => {
    await put({ days: -1 });
    expect(status).toBe(400);
    await put({ enabled: 'yes' });
    expect(status).toBe(400);
    expect(await getTurnTraceDays()).toBe(90);
    expect(await getTurnTracesEnabled()).toBe(true);
  });
});
