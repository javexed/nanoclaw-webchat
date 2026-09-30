/**
 * HTTP/authz tests for the thread endpoints — the route layer (CSRF, input
 * validation, the owner / main-thread guards, 404s) that the storage-layer
 * tests in threads.test.ts don't reach. Boots the server on an ephemeral port
 * (loopback no-auth path → owner) and drives the real endpoints over fetch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';

import { loadServer, LOOPBACK_ENV, noopHooks, portOf, resetServerModules } from './test-server.js';

// The loopback no-auth path authenticates as this identity (auth.ts).
const LOCAL_OWNER = 'webchat:local-owner';

afterEach(resetServerModules);

// Boot a server on the loopback no-auth path (→ owner) with one seeded room.
// db.js is imported dynamically AFTER resetModules so the test and the server
// share the same module instance (and therefore the same DB connection).
async function boot() {
  const { server, conn } = await loadServer(LOOPBACK_ENV);
  const db = await import('./db.js');

  // Seed an *accessible* room: canAccessRoom requires the room to have ≥1 wired
  // agent the caller can reach. Wire one agent and make the loopback user owner
  // (mirrors access.test.ts) so the owner-gated routes (e.g. DELETE) are
  // exercised rather than short-circuited at the access check.
  const dbh = conn.getDb();
  const now = new Date().toISOString();
  await dbh.run(
    `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
    'ag-1',
    'Agent',
    'agent',
    now,
  );
  await dbh.run(
    `INSERT OR IGNORE INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES ('room-1', 'webchat', 'webchat', 'room-1', 'Room', 0, 'public', ?)`,
    now,
  );
  await dbh.run(
    `INSERT OR IGNORE INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, 'room-1', 'ag-1', 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`,
    randomUUID(),
    now,
  );
  await dbh.run(
    `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`,
    LOCAL_OWNER,
    now,
  );
  await dbh.run(
    `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`,
    LOCAL_OWNER,
    now,
  );

  const wc = await server.startWebchatServer(noopHooks);
  return { server, wc, db };
}

const CSRF = { 'content-type': 'application/json', 'x-webchat-csrf': '1' };

describe('thread endpoints — HTTP/authz', () => {
  it('creates, lists, renames, and deletes a topic thread (owner/loopback)', async () => {
    const { server, wc } = await boot();
    try {
      const base = `http://127.0.0.1:${portOf(wc)}/api/rooms/room-1/threads`;

      // create
      let res = await fetch(base, { method: 'POST', headers: CSRF, body: JSON.stringify({ title: 'Topic A' }) });
      expect(res.status).toBe(200);
      const created = (await res.json()) as { thread_id: string; title: string };
      expect(created.title).toBe('Topic A');
      expect(created.thread_id).toBeTruthy();

      // list includes the main thread + the new topic thread
      res = await fetch(base);
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ thread_id: string }>;
      const ids = list.map((t) => t.thread_id);
      expect(ids).toContain('main');
      expect(ids).toContain(created.thread_id);

      // rename
      res = await fetch(`${base}/${created.thread_id}`, {
        method: 'PATCH',
        headers: CSRF,
        body: JSON.stringify({ title: 'Renamed' }),
      });
      expect(res.status).toBe(200);

      // delete → gone from the list
      res = await fetch(`${base}/${created.thread_id}`, { method: 'DELETE', headers: CSRF });
      expect(res.status).toBe(200);
      res = await fetch(base);
      const after = (await res.json()) as Array<{ thread_id: string }>;
      expect(after.map((t) => t.thread_id)).not.toContain(created.thread_id);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('enforces CSRF, input validation, and the main / 404 guards', async () => {
    const { server, wc } = await boot();
    try {
      const p = portOf(wc);
      const base = `http://127.0.0.1:${p}/api/rooms/room-1/threads`;

      // missing CSRF header → 403
      let res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'X' }),
      });
      expect(res.status).toBe(403);

      // blank title → 400
      res = await fetch(base, { method: 'POST', headers: CSRF, body: JSON.stringify({ title: '   ' }) });
      expect(res.status).toBe(400);

      // unknown room → 404
      res = await fetch(`http://127.0.0.1:${p}/api/rooms/nope/threads`, {
        method: 'POST',
        headers: CSRF,
        body: JSON.stringify({ title: 'X' }),
      });
      expect(res.status).toBe(404);

      // the main thread cannot be deleted → 400
      res = await fetch(`${base}/main`, { method: 'DELETE', headers: CSRF });
      expect(res.status).toBe(400);

      // deleting a nonexistent topic thread → 404
      res = await fetch(`${base}/ghost`, { method: 'DELETE', headers: CSRF });
      expect(res.status).toBe(404);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });
});
