import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-learn-route' };
});

const wakes: string[] = [];
vi.mock('../../container-runner.js', () => ({
  wakeContainer: async (session: { id: string }) => {
    wakes.push(session.id);
    return true;
  },
}));

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { openInboundDb, initSessionFolder } from '../../session-manager.js';
import { upsertUserCredential } from '../user-credentials/db.js';
import { handleRouteLearningReview } from './route-review.js';
import type { Session } from '../../types.js';

const AG = 'ag-learn-route';
const MG = 'mg-room-1';

async function seed(learning: Record<string, unknown> | null): Promise<Session> {
  await createAgentGroup({ id: AG, name: 'Learn Route', folder: 'learn-route', agent_provider: null, created_at: now() });
  await getDb().run(`INSERT INTO container_configs (agent_group_id, skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, learning, updated_at)
       VALUES (?, '["all"]', '{}', '[]', '[]', '[]', 'group', ?, ?)`, AG, learning ? JSON.stringify(learning) : null, now());
  await getDb().run(`INSERT INTO messaging_groups (id, channel_type, platform_id, name, instance, created_at)
       VALUES (?, 'webchat', 'room-1', 'Room One', 'webchat', ?)`, MG, now());
  const session: Session = {
    id: 'sess-origin',
    agent_group_id: AG,
    messaging_group_id: MG,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    created_at: now(),
    last_active: now(),
  } as unknown as Session;
  await createSession(session);
  // Materialize the origin session's dir + DB files — in production the
  // room's container created them long before anyone typed /learn; the
  // decline notice writes into the existing outbound.db.
  initSessionFolder(AG, session.id);
  return session;
}

async function addUser(id: string): Promise<void> {
  await getDb().run(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'human', ?, ?)`, id, id, now());
}

/** Membership is the floor gate in every mode — a non-member never spends. */
async function addMember(id: string): Promise<void> {
  await addUser(id);
  await getDb().run(`INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, ?, ?)`, id, AG, id, now());
}

function now(): string {
  return new Date().toISOString();
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'route_learning_review',
    text: '/learn focus',
    digest: '<exchange>D</exchange>',
    requested_by: 'webchat:alice',
    origin: { channel_type: 'webchat', platform_id: 'room-1' },
    ...overrides,
  };
}

function inboundTexts(sessionId: string): string[] {
  const db = openInboundDb(AG, sessionId);
  try {
    return (db.prepare(`SELECT content FROM messages_in`).all() as { content: string }[]).map(
      (r) => (JSON.parse(r.content) as { text?: string }).text ?? '',
    );
  } finally {
    db.close();
  }
}

function outboundTexts(sessionId: string): string[] {
  const dir = `/tmp/nanoclaw-test-learn-route/v2-sessions/${AG}/${sessionId}`;
  if (!fs.existsSync(`${dir}/outbound.db`)) return [];
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(`${dir}/outbound.db`, { readonly: true });
  try {
    return (db.prepare(`SELECT content FROM messages_out`).all() as { content: string }[]).map(
      (r) => (JSON.parse(r.content) as { text?: string }).text ?? '',
    );
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync('/tmp/nanoclaw-test-learn-route', { recursive: true, force: true });
  await initTestDb();
  await runMigrations(getDb());
  wakes.length = 0;
});

afterEach(async () => {
  await closeDb();
  fs.rmSync('/tmp/nanoclaw-test-learn-route', { recursive: true, force: true });
});

describe('handleRouteLearningReview — enrollment and policy', () => {
  it('routes to the invoker’s member session when they have a connected credential', async () => {
    const origin = await seed({ chargeInvoker: 'auto' });
    await addMember('webchat:alice');
    await upsertUserCredential('webchat:alice', 'claude', 'secret-1', 'api_key');

    await handleRouteLearningReview(payload(), await origin);

    // A per-member session (thread_id = user id) now exists and got the row.
    const member = (await getSessionsByAgentGroup(AG)).find((s) => s.thread_id === 'webchat:alice');
    expect(member).toBeDefined();
    const texts = inboundTexts(member!.id);
    expect(texts).toHaveLength(1);
    expect(texts[0].startsWith('/learn-routed ')).toBe(true);
    const routed = JSON.parse(texts[0].slice('/learn-routed '.length)) as Record<string, unknown>;
    expect(routed.text).toBe('/learn focus');
    expect(routed.digest).toBe('<exchange>D</exchange>');
    expect(routed.origin).toEqual({ channel_type: 'webchat', platform_id: 'room-1' });
    expect(wakes).toEqual([member!.id]);
  });

  it('declines with a notice when unenrolled and chargeInvoker is require', async () => {
    const origin = await seed({ chargeInvoker: 'require' });
    await addMember('webchat:alice');

    await handleRouteLearningReview(payload(), origin);

    expect((await getSessionsByAgentGroup(AG)).find((s) => s.thread_id === 'webchat:alice')).toBeUndefined();
    expect(wakes).toHaveLength(0);
    const notices = outboundTexts(origin.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('your own credential');
  });

  it('falls back to the origin session (workspace credential) for a privileged invoker', async () => {
    const origin = await seed({ chargeInvoker: 'auto' });
    await addUser('webchat:boss');
    await getDb().run(`INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('webchat:boss', 'owner', NULL, ?)`, now());

    await handleRouteLearningReview(payload({ requested_by: 'webchat:boss' }), origin);

    const texts = inboundTexts(origin.id);
    expect(texts).toHaveLength(1);
    expect(texts[0].startsWith('/learn-routed ')).toBe(true);
    expect(wakes).toEqual([origin.id]);
  });

  it('DECLINES a non-member in every mode — the membership gate is the floor', async () => {
    const origin = await seed({ chargeInvoker: 'off' }); // even the most permissive mode
    await addUser('webchat:stranger'); // a user, but NOT a member of this agent group

    await handleRouteLearningReview(payload({ requested_by: 'webchat:stranger' }), origin);

    expect(wakes).toHaveLength(0);
    expect(inboundTexts(origin.id)).toHaveLength(0);
    expect(outboundTexts(origin.id)[0]).toContain('limited to members');
  });

  it("'off' lets a plain member spend the workspace credential in the origin session", async () => {
    const origin = await seed({ chargeInvoker: 'off' });
    await addMember('webchat:dave');

    await handleRouteLearningReview(payload({ requested_by: 'webchat:dave', charge_mode: 'off' }), origin);

    const texts = inboundTexts(origin.id);
    expect(texts).toHaveLength(1);
    expect(texts[0].startsWith('/learn-routed ')).toBe(true);
    expect(wakes).toEqual([origin.id]);
  });

  it('defaults to auto when no mode is configured (a review is real spend)', async () => {
    const origin = await seed({}); // learning configured, but no chargeInvoker key
    await addMember('webchat:erin'); // member, not enrolled, not privileged

    await handleRouteLearningReview(payload({ requested_by: 'webchat:erin', charge_mode: undefined }), origin);

    // auto + unenrolled + unprivileged → declined, NOT a workspace-credential run
    expect(wakes).toHaveLength(0);
    expect(outboundTexts(origin.id)[0]).toContain('your own connected credential');
  });

  it('declines an unenrolled, unprivileged invoker in auto mode', async () => {
    const origin = await seed({ chargeInvoker: 'auto' });
    await addMember('webchat:carol');

    await handleRouteLearningReview(payload({ requested_by: 'webchat:carol' }), origin);

    expect(wakes).toHaveLength(0);
    expect(inboundTexts(origin.id)).toHaveLength(0);
    const notices = outboundTexts(origin.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('credential');
  });
});
