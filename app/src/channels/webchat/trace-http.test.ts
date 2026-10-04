/**
 * Turn traces through the real server: the routes are wired, history flags a
 * reply with a stored trace without carrying the trace, and the owner's
 * settings take the CSRF header like every other write.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Session } from '../../types.js';
import { httpRequest, LOOPBACK_ENV, resetServerModules, startServer } from './test-server.js';

afterEach(async () => {
  await resetServerModules();
});

const NOW = new Date().toISOString();

async function boot() {
  const started = await startServer(LOOPBACK_ENV);
  // Imported after startServer's resetModules, so they share its DB connection.
  const db = await import('./db.js');
  const traces = await import('./turn-traces.js');
  const conn = started.conn.getDb();
  await db.createWebchatRoom('Gardens', 'gardens');
  await conn.run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-1', 'AG', 'ag', NULL, ?)`,
    NOW,
  );
  const mg = (await conn.get(`SELECT id FROM messaging_groups WHERE platform_id = 'gardens'`)) as { id: string };
  await conn.run(
    `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
     VALUES ('w-1', ?, 'ag-1', 'always', 'all', 'ignore', 'shared', 0, ?)`,
    mg.id,
    NOW,
  );
  const session = { id: 's1', agent_group_id: 'ag-1', messaging_group_id: mg.id, thread_id: null } as Session;
  const at = () => new Date().toISOString();
  await traces.recordStatusEvent(session, { kind: 'start', text: null, detail: null, createdAt: at() });
  await traces.recordStatusEvent(session, { kind: 'tool', text: 'Read', detail: 'notes.md', createdAt: at() });
  const anchor = (await db.storeWebchatMessage('gardens', 'AG', 'agent', 'done')).id;
  await traces.recordTurnMessage('s1', anchor, null);
  await traces.recordStatusEvent(session, { kind: 'done', text: null, detail: null, createdAt: at() });
  const plain = (await db.storeWebchatMessage('gardens', 'AG', 'agent', 'no trace here')).id;
  return { ...started, anchor, plain };
}

describe('turn traces over HTTP', () => {
  it('history flags the anchor reply and carries no trace', async () => {
    const { wc, port, server, anchor, plain } = await boot();
    try {
      const res = await httpRequest(port, 'GET', '/api/rooms/gardens/messages');
      expect(res.status).toBe(200);
      const rows = JSON.parse(res.body) as Record<string, unknown>[];
      expect(rows.find((m) => m.id === anchor)).toMatchObject({ has_trace: true });
      expect(rows.find((m) => m.id === plain)).not.toHaveProperty('has_trace');
      expect(res.body).not.toContain('notes.md');
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('GET /api/messages/:id/trace is routed', async () => {
    const { wc, port, server, anchor, plain } = await boot();
    try {
      const res = await httpRequest(port, 'GET', `/api/messages/${anchor}/trace`);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).trace.tools[0]).toMatchObject({ name: 'Read', target: 'notes.md' });
      expect((await httpRequest(port, 'GET', `/api/messages/${plain}/trace`)).status).toBe(404);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('settings: owner reads them; a write needs the CSRF header', async () => {
    const { wc, port, server } = await boot();
    try {
      const get = await httpRequest(port, 'GET', '/api/webchat/turn-traces');
      expect(get.status).toBe(200);
      expect(JSON.parse(get.body)).toEqual({ enabled: true, days: 90 });
      const body = JSON.stringify({ days: 30 });
      const json = { 'content-type': 'application/json' };
      expect((await httpRequest(port, 'PUT', '/api/webchat/turn-traces', json, body)).status).toBe(403);
      const put = await httpRequest(port, 'PUT', '/api/webchat/turn-traces', { ...json, 'x-webchat-csrf': '1' }, body);
      expect(put.status).toBe(200);
      expect(JSON.parse(put.body)).toEqual({ enabled: true, days: 30 });
    } finally {
      await server.stopWebchatServer(wc);
    }
  });
});
