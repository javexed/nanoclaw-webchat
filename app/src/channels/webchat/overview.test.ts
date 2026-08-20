/**
 * Overview-endpoint tests — verifies the `/api/overview` response shape,
 * owner-vs-admin graceful degrade, and the basic count math (agents,
 * sessions, 24h messages, channels).
 *
 * Boots the server on an ephemeral port for each scenario so the env-var
 * gates (auth mode, token strength) are honoured the same way they would
 * be in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

beforeEach(async () => {
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const conn = await import('../../db/connection.js');
    await conn.closeDb();
  } catch {
    // ignore
  }
  vi.resetModules();
});

async function bootLocalhost() {
  vi.stubEnv('WEBCHAT_HOST', '127.0.0.1');
  vi.stubEnv('WEBCHAT_PORT', '0');
  vi.stubEnv('WEBCHAT_TOKEN', '');
  vi.stubEnv('WEBCHAT_TAILSCALE', '');
  vi.stubEnv('WEBCHAT_TRUSTED_PROXY_IPS', '');
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  await migrations.runMigrations(conn.getDb());
  const server = await import('./server.js');
  const wc = await server.startWebchatServer(noopHooks);
  return { server, wc, conn };
}

function port(wc: { http: { address: () => unknown } }): number {
  const addr = wc.http.address() as { port: number } | null;
  if (!addr) throw new Error('server has no address');
  return addr.port;
}

async function getOverview(wc: {
  http: { address: () => unknown };
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port(wc)}/api/overview`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/overview — owner (loopback no-auth path)', () => {
  it('returns the full snapshot shape', async () => {
    const { server, wc } = await bootLocalhost();
    try {
      const { status, body } = await getOverview(wc);
      expect(status).toBe(200);
      // restricted=false on the owner path — loopback bypass with no
      // permissions module degrades to "trust authenticated" → owner.
      expect(body).toMatchObject({
        restricted: false,
        agents: expect.objectContaining({ total: expect.any(Number), visible: expect.any(Number) }),
        sessions: expect.objectContaining({ active: expect.any(Number), total: expect.any(Number) }),
        messages: expect.objectContaining({ webchat_24h: expect.any(Number) }),
        channels: expect.any(Object),
        recent_agents: expect.any(Array),
      });
      // System metrics only present for owner.
      expect(body.system).toBeTruthy();
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('counts agents and channel wirings correctly', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      // Seed 2 agents + 2 webchat rooms + 1 wiring.
      const now = new Date().toISOString();
      const agentA = randomUUID();
      const agentB = randomUUID();
      await db.run(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`, agentA, 'Alpha', 'alpha', now);
      await db.run(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`, agentB, 'Beta', 'beta', now);
      const mgA = randomUUID();
      await db.run(`INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'webchat', 'webchat', 'alpha', 'Alpha', 1, 'public', ?)`, mgA, now);
      await db.run(`INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'whatsapp', 'whatsapp', '1234@g.us', 'Group', 1, 'public', ?)`, randomUUID(), now);
      await db.run(`INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`, randomUUID(), mgA, agentA, now);

      const { body } = await getOverview(wc);
      expect(body.agents).toMatchObject({ total: 2, visible: 2 });
      expect(body.channels).toEqual({ webchat: 1, whatsapp: 1 });
      expect((body.recent_agents as Array<{ name: string }>).map((a) => a.name).sort()).toEqual(['Alpha', 'Beta']);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('counts webchat messages in the last 24 hours, not older ones', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      const now = new Date().toISOString();
      // Seed a room first.
      await db.run(`INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'webchat', 'webchat', 'r1', 'R1', 1, 'public', ?)`, randomUUID(), now);
      // 3 messages in the last hour, 1 from 25 hours ago.
      const recent = Date.now();
      const old = Date.now() - 25 * 3600 * 1000;
      const INSERT_MSG = `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
         VALUES (?, 'r1', 'alice', 'user', ?, 'text', NULL, ?)`;
      await db.run(INSERT_MSG, randomUUID(), 'hi', recent);
      await db.run(INSERT_MSG, randomUUID(), 'hello', recent);
      await db.run(INSERT_MSG, randomUUID(), 'yo', recent);
      await db.run(INSERT_MSG, randomUUID(), 'old', old);

      const { body } = await getOverview(wc);
      expect((body.messages as { webchat_24h: number }).webchat_24h).toBe(3);
      const busiest = body.busiest_rooms as Array<{ id: string; count: number }>;
      expect(busiest).toHaveLength(1);
      expect(busiest[0]).toMatchObject({ id: 'r1', count: 3 });
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('counts active sessions by last_active within the 5-minute window', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      const now = new Date().toISOString();
      const agentId = randomUUID();
      await db.run(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, 'A', 'a', NULL, ?)`, agentId, now);
      // 1 active session, 1 idle session.
      const active = new Date(Date.now() - 60_000).toISOString();
      const idle = new Date(Date.now() - 10 * 60_000).toISOString();
      await db.run(`INSERT INTO sessions (id, agent_group_id, status, last_active, created_at) VALUES (?, ?, 'active', ?, ?)`, 'sess-active', agentId, active, now);
      await db.run(`INSERT INTO sessions (id, agent_group_id, status, last_active, created_at) VALUES (?, ?, 'active', ?, ?)`, 'sess-idle', agentId, idle, now);

      const { body } = await getOverview(wc);
      expect(body.sessions).toMatchObject({ active: 1, total: 2 });
    } finally {
      await server.stopWebchatServer(wc);
    }
  });
});

/**
 * The RESTRICTED branch — previously untested entirely, which is how it came
 * to serve install-wide session/message/channel counts to every non-owner
 * while the drill-down panels beside them were properly scoped.
 *
 * Making the loopback caller non-owner is the whole trick: seed a DIFFERENT
 * owner before the first request, so `ensureOwnerRoleOnFirstLogin` finds an
 * owner already present and leaves `webchat:local-owner` unprivileged. That
 * is the same shape as a real install where someone else claimed owner first.
 */
type TestDb = import('../../db/driver.js').DbDriver;

describe('GET /api/overview — restricted (non-owner caller)', () => {
  const OTHER_OWNER = 'webchat:someone-else';
  const CALLER = 'webchat:local-owner';

  async function seedOwnerElsewhere(db: TestDb): Promise<void> {
    const now = new Date().toISOString();
    await db.run(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`, OTHER_OWNER, now);
    await db.run(`INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`, OTHER_OWNER, now);
  }

  /** Two agents, two rooms, sessions and messages on both. Caller joins only A. */
  async function seedSplitWorld(db: TestDb, joinAgentA: boolean): Promise<void> {
    const now = new Date().toISOString();
    const agentA = 'agent-a';
    const agentB = 'agent-b';
    for (const [id, name, folder] of [
      [agentA, 'Alpha', 'alpha'],
      [agentB, 'Beta', 'beta'],
    ]) {
      await db.run(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`, id, name, folder, now);
    }
    // Rooms: platform_id IS the webchat room id (see getAllWebchatRooms).
    for (const [platformId, agent] of [
      ['room-a', agentA],
      ['room-b', agentB],
    ]) {
      const mg = randomUUID();
      await db.run(`INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, 'webchat', 'webchat', ?, ?, 1, 'public', ?)`, mg, platformId, platformId, now);
      await db.run(`INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`, randomUUID(), mg, agent, now);
    }
    // A non-webchat channel too, so a leaked `channels` map would be obvious.
    await db.run(`INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'whatsapp', 'whatsapp', '1234@g.us', 'G', 1, 'public', ?)`, randomUUID(), now);

    // Sessions: A has 1 active + 1 idle, B has 2 active.
    const active = new Date(Date.now() - 60_000).toISOString();
    const idle = new Date(Date.now() - 10 * 60_000).toISOString();
    const INSERT_SESSION = `INSERT INTO sessions (id, agent_group_id, status, last_active, created_at) VALUES (?, ?, 'active', ?, ?)`;
    await db.run(INSERT_SESSION, 'a-active', agentA, active, now);
    await db.run(INSERT_SESSION, 'a-idle', agentA, idle, now);
    await db.run(INSERT_SESSION, 'b-active-1', agentB, active, now);
    await db.run(INSERT_SESSION, 'b-active-2', agentB, active, now);

    // Messages: 2 in room-a, 5 in room-b, all inside the 24h window.
    const recent = Date.now();
    const INSERT_MSG = `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (?, ?, 'alice', 'user', 'hi', 'text', NULL, ?)`;
    for (let i = 0; i < 2; i++) await db.run(INSERT_MSG, randomUUID(), 'room-a', recent);
    for (let i = 0; i < 5; i++) await db.run(INSERT_MSG, randomUUID(), 'room-b', recent);

    if (joinAgentA) {
      await db.run(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`, CALLER, now);
      await db.run(`INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`, CALLER, agentA, now);
    }
  }

  it('scopes sessions and messages to what the caller can access', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      await seedOwnerElsewhere(db);
      await seedSplitWorld(db, true);

      const { body } = await getOverview(wc);
      expect(body.restricted).toBe(true);
      // Only agent-a's sessions: 1 of its 2 is active. agent-b's 2 active
      // sessions must not appear anywhere in these numbers.
      expect(body.sessions).toMatchObject({ active: 1, total: 2 });
      // Only room-a's 2 messages, not room-b's 5.
      expect((body.messages as { webchat_24h: number }).webchat_24h).toBe(2);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('reports zero — not install-wide totals — for a caller with no access', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      await seedOwnerElsewhere(db);
      await seedSplitWorld(db, false);

      const { body } = await getOverview(wc);
      expect(body.restricted).toBe(true);
      // Empty scope short-circuits the IN () query; it must not fall back to
      // an unfiltered count.
      expect(body.sessions).toMatchObject({ active: 0, total: 0 });
      expect((body.messages as { webchat_24h: number }).webchat_24h).toBe(0);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('withholds install-wide facts on the wire, not just in the GUI', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      await seedOwnerElsewhere(db);
      await seedSplitWorld(db, true);

      const { body } = await getOverview(wc);
      expect(body.channels).toBeNull();
      expect((body.agents as { total: number | null }).total).toBeNull();
      expect((body.health as { uptime: number | null }).uptime).toBeNull();
      // Already-withheld fields stay withheld.
      expect(body.system).toBeNull();
      expect(body.ollama).toBeNull();
      expect(body.busiest_rooms).toBeNull();
      expect(body.active_containers).toBeNull();
    } finally {
      await server.stopWebchatServer(wc);
    }
  });

  it('still reports the caller-visible agent count', async () => {
    const { server, wc, conn } = await bootLocalhost();
    try {
      const db = conn.getDb();
      await seedOwnerElsewhere(db);
      await seedSplitWorld(db, true);

      const { body } = await getOverview(wc);
      // Membership is not admin privilege, so the agents card — which mirrors
      // /api/agents — legitimately shows 0 here even though the caller can
      // access room-a. The two predicates differ on purpose.
      expect((body.agents as { visible: number }).visible).toBe(0);
    } finally {
      await server.stopWebchatServer(wc);
    }
  });
});
