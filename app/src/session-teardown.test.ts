/**
 * Tests for session teardown primitives.
 *
 * Locks in the contract that motivated extracting these helpers: every
 * parent-delete path that holds an FK to `sessions` must use them, or the
 * SQLite FK check rejects the parent delete with "FOREIGN KEY constraint
 * failed". Regressions here would resurface as cryptic "Internal error"
 * responses in channel skills.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup, deleteAgentGroup } from './db/agent-groups.js';
import { createMessagingGroup, deleteMessagingGroup } from './db/messaging-groups.js';
import { createPendingApproval, createPendingQuestion, createSession, getSession } from './db/sessions.js';
import { deleteSessionDbState, findSessionsByAgentGroup, findSessionsByMessagingGroup } from './session-teardown.js';

const now = () => new Date().toISOString();

function seed(opts: { sessionsPerRoom?: number } = {}): { agentGroupId: string; messagingGroupId: string } {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'webchat',
    platform_id: 'room-1',
    name: 'Test Room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const count = opts.sessionsPerRoom ?? 1;
  for (let i = 1; i <= count; i++) {
    createSession({
      id: `sess-${i}`,
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: i === 1 ? null : `thread-${i}`,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now(),
      created_at: now(),
    });
  }
  return { agentGroupId: 'ag-1', messagingGroupId: 'mg-1' };
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(await db);
});

afterEach(async () => {
  await closeDb();
});

describe('findSessionsByMessagingGroup / findSessionsByAgentGroup', () => {
  it('returns every session linked to the messaging group', async () => {
    seed({ sessionsPerRoom: 3 });
    const targets = await findSessionsByMessagingGroup('mg-1');
    expect(targets).toHaveLength(3);
    expect(targets.every((t) => t.agentGroupId === 'ag-1')).toBe(true);
    expect(new Set(targets.map((t) => t.sessionId))).toEqual(new Set(['sess-1', 'sess-2', 'sess-3']));
  });

  it('returns every session linked to the agent group across rooms', async () => {
    seed({ sessionsPerRoom: 1 });
    await createMessagingGroup({
      id: 'mg-2',
      channel_type: 'webchat',
      platform_id: 'room-2',
      name: 'Other Room',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createSession({
      id: 'sess-other-room',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-2',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now(),
      created_at: now(),
    });
    expect(await findSessionsByAgentGroup('ag-1')).toHaveLength(2);
    expect(await findSessionsByMessagingGroup('mg-2')).toHaveLength(1);
  });

  it('returns empty for unknown ids', async () => {
    expect(await findSessionsByMessagingGroup('nope')).toEqual([]);
    expect(await findSessionsByAgentGroup('nope')).toEqual([]);
  });
});

describe('deleteSessionDbState', () => {
  it('drops the session row', async () => {
    seed();
    await deleteSessionDbState('sess-1');
    expect(await getSession('sess-1')).toBeUndefined();
  });

  it('drops pending_questions and pending_approvals that FK to the session', async () => {
    seed();
    await createPendingQuestion({
      question_id: 'q-1',
      session_id: 'sess-1',
      message_out_id: 'msg-out-1',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      title: 'Ask?',
      options: [],
      created_at: now(),
    });
    await createPendingApproval({
      approval_id: 'a-1',
      session_id: 'sess-1',
      request_id: 'req-1',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install?',
      options_json: '[]',
    });
    await deleteSessionDbState('sess-1');
    const db = getDb();
    expect(await db.get('SELECT COUNT(*) as n FROM pending_questions WHERE session_id = ?', 'sess-1')).toEqual({
      n: 0,
    });
    expect(await db.get('SELECT COUNT(*) as n FROM pending_approvals WHERE session_id = ?', 'sess-1')).toEqual({
      n: 0,
    });
  });
});

describe('FK behavior — the bug this primitive prevents', () => {
  it('deleting a messaging_group with an active session throws FOREIGN KEY', async () => {
    await seed();
    // Without teardown, SQLite rejects the parent delete. This is the
    // exact scenario that surfaced as "Failed to delete room: Internal
    // error" in the webchat UI.
    await expect(deleteMessagingGroup('mg-1')).rejects.toThrow(/FOREIGN KEY/);
  });

  it('deleting an agent_group with an active session throws FOREIGN KEY', async () => {
    seed();
    await expect(deleteAgentGroup('ag-1')).rejects.toThrow(/FOREIGN KEY/);
  });

  it('the teardown + parent-delete sequence inside a transaction succeeds', async () => {
    const { messagingGroupId } = seed({ sessionsPerRoom: 2 });
    const targets = await findSessionsByMessagingGroup(messagingGroupId);
    expect(targets).toHaveLength(2);

    await getDb().transaction(async () => {
      for (const t of targets) await deleteSessionDbState(t.sessionId);
      await deleteMessagingGroup(messagingGroupId);
    });

    const db = getDb();
    expect(await db.get('SELECT COUNT(*) as n FROM messaging_groups WHERE id = ?', messagingGroupId)).toEqual({
      n: 0,
    });
    expect(await db.get('SELECT COUNT(*) as n FROM sessions WHERE messaging_group_id = ?', messagingGroupId)).toEqual({
      n: 0,
    });
  });

  it('a failing parent-delete inside a transaction rolls back the session teardown', async () => {
    seed();
    // Simulate a multi-step delete where the final step fails AFTER the
    // session was torn down. The transaction must roll back both, leaving
    // the session intact for a retry — no half-gutted state.
    await expect(
      getDb().transaction(async () => {
        await deleteSessionDbState('sess-1');
        // Force a failure inside the transaction.
        throw new Error('simulated handler failure');
      }),
    ).rejects.toThrow(/simulated/);
    expect(await getSession('sess-1')).toBeDefined();
  });
});
