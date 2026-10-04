import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { approved } = vi.hoisted(() => ({ approved: vi.fn() }));
vi.mock('../../modules/approvals/response-handler.js', () => ({
  resolveApprovalAsApproved: (...a: unknown[]) => approved(...a),
}));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, createSession } from '../../db/sessions.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { grantRole } from '../../modules/permissions/db/user-roles.js';
import type { Session } from '../../types.js';
import {
  __resetForTest,
  ASKED_WINDOW_MS,
  approveAdminModelSwitch,
  asksForModel,
  noteHumanMessage,
} from './admin-model-switch.js';
import { createWebchatModel } from './db.js';

const now = () => new Date().toISOString();
const G = 'ag-m';
const ADMIN = 'webchat:admin@x';
const USER = 'webchat:user@x';
let session: Session;
let n = 0;

async function hold(command: string, args: Record<string, unknown>): Promise<string> {
  const id = `appr-${++n}`;
  await createPendingApproval({
    approval_id: id,
    request_id: id,
    session_id: session.id,
    action: 'cli_command',
    payload: JSON.stringify({ frame: { id: 'r', command, args }, callerContext: {} }),
    created_at: now(),
    title: 't',
    options_json: '[]',
  });
  return id;
}
const modelSwitch = () =>
  hold('groups-config-update', { model: 'claude-opus-5-5', id: G, agent_group_id: G, group: G });

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  __resetForTest();
  approved.mockReset();
  await createAgentGroup({ id: G, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-room',
    channel_type: 'webchat',
    platform_id: 'room',
    name: 'Room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  session = {
    id: 'sess-m',
    agent_group_id: G,
    messaging_group_id: 'mg-room',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: now(),
  };
  await createSession(session);
  for (const id of [ADMIN, USER]) await createUser({ id, kind: 'email', display_name: id, created_at: now() });
  await grantRole({ user_id: ADMIN, role: 'admin', agent_group_id: G, granted_by: null, granted_at: now() });
});
afterEach(async () => {
  await closeDb();
});

describe('a model switch the agent admin asked for', () => {
  it('is approved as that admin, with no card', async () => {
    noteHumanMessage('room', null, ADMIN, 'switch to opus please');
    const id = await modelSwitch();
    expect(await approveAdminModelSwitch(id, session)).toBe(true);
    expect(approved).toHaveBeenCalledWith(expect.objectContaining({ approval_id: id }), ADMIN);
  });

  it('gets a card when a non-admin wrote in the thread too, or no one is on record', async () => {
    expect(await approveAdminModelSwitch(await modelSwitch(), session)).toBe(false);
    noteHumanMessage('room', null, ADMIN, 'switch to opus please');
    noteHumanMessage('room', null, USER, 'ok');
    expect(await approveAdminModelSwitch(await modelSwitch(), session)).toBe(false);
    expect(approved).not.toHaveBeenCalled();
  });

  it('gets a card for an admin who wrote in another thread, or too long ago', async () => {
    noteHumanMessage('room', 'thread-1', ADMIN, 'switch to opus please');
    noteHumanMessage('room', null, ADMIN, 'switch to opus please', Date.now() - ASKED_WINDOW_MS - 1000);
    expect(await approveAdminModelSwitch(await modelSwitch(), session)).toBe(false);
  });

  it('in a per-member session, goes by that member alone', async () => {
    session = { ...session, id: 'sess-member', thread_id: `${ADMIN}::main` };
    await createSession(session);
    noteHumanMessage('room', null, USER, 'switch to opus please'); // wrote to their own session, not this one
    expect(await approveAdminModelSwitch(await modelSwitch(), session)).toBe(false);
    noteHumanMessage('room', null, ADMIN, 'switch to opus please');
    expect(await approveAdminModelSwitch(await modelSwitch(), session)).toBe(true);
    const userSession = { ...session, id: 'sess-user', thread_id: `${USER}::main` };
    await createSession(userSession);
    expect(await approveAdminModelSwitch(await modelSwitch(), userSession)).toBe(false);
  });

  it('gets a card for anything but the model of its own group', async () => {
    noteHumanMessage('room', null, ADMIN, 'switch to opus please');
    const others = [
      await hold('groups-config-update', { model: 'x', egress: 'open', id: G }),
      await hold('groups-config-update', { model: 'x', id: 'ag-other' }),
      await hold('groups-config-update', { effort: 'high', id: G }),
      await hold('groups-restart', { id: G }),
    ];
    for (const id of others) expect(await approveAdminModelSwitch(id, session)).toBe(false);
    expect(approved).not.toHaveBeenCalled();
  });

  // What it asked for, not just who wrote: a switch the agent reached by itself,
  // or was talked into by a page it read, after an admin said something else.
  it("gets a card when the admin's latest message does not name the target", async () => {
    noteHumanMessage('room', null, ADMIN, 'summarise this page for me');
    expect(await approveAdminModelSwitch(await modelSwitch(), session)).toBe(false);
    // "model" alone says a switch, not which one: the agent picked the target.
    noteHumanMessage('room', null, ADMIN, 'use a bigger model for this');
    expect(await approveAdminModelSwitch(await modelSwitch(), session)).toBe(false);
    noteHumanMessage('room', null, ADMIN, 'switch models to sonnet');
    expect(await approveAdminModelSwitch(await modelSwitch(), session)).toBe(false);
    noteHumanMessage('room', null, ADMIN, 'use opus for this');
    expect(await approveAdminModelSwitch(await modelSwitch(), session)).toBe(true);
  });

  it('accepts the display name a target is registered under', async () => {
    await createWebchatModel({
      id: 'm-big',
      name: 'Big Brain',
      kind: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model_id: 'hf.co/x/y:q4',
      credential_ref: null,
      created_at: Date.now(),
    });
    noteHumanMessage('room', null, ADMIN, 'change the model please');
    const id = await hold('groups-config-update', { model: 'hf.co/x/y:q4', id: G });
    expect(await approveAdminModelSwitch(id, session)).toBe(false);
    noteHumanMessage('room', null, ADMIN, 'switch to big brain');
    const ok = await hold('groups-config-update', { model: 'hf.co/x/y:q4', id: G });
    expect(await approveAdminModelSwitch(ok, session)).toBe(true);
  });

  it('gets a card for a target that is neither registered nor an Anthropic model id', async () => {
    noteHumanMessage('room', null, ADMIN, 'switch the model to evil-proxy-model');
    const id = await hold('groups-config-update', { model: 'evil-proxy-model', id: G });
    expect(await approveAdminModelSwitch(id, session)).toBe(false);
    await createWebchatModel({
      id: 'm-local',
      name: 'Local',
      kind: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model_id: 'qwen3:8b',
      credential_ref: null,
      created_at: Date.now(),
    });
    noteHumanMessage('room', null, ADMIN, 'switch to qwen3 please');
    const ok = await hold('groups-config-update', { model: 'qwen3:8b', id: G });
    expect(await approveAdminModelSwitch(ok, session)).toBe(true);
  });
});

describe('asksForModel', () => {
  it('reads a distinctive name of the target, not "model" or "claude" alone', () => {
    expect(asksForModel('Switch models, please', 'claude-sonnet-5')).toBe(false);
    expect(asksForModel('use the latest model', 'claude-sonnet-latest')).toBe(false);
    expect(asksForModel('go with Sonnet', 'claude-sonnet-5')).toBe(true);
    expect(asksForModel('ask claude about it', 'claude-sonnet-5')).toBe(false);
    expect(asksForModel('thanks!', 'qwen3:8b')).toBe(false);
    expect(asksForModel('qwen3 please', 'qwen3:8b')).toBe(true);
  });

  it('matches whole words, and registered display names', () => {
    expect(asksForModel('do it automatically', 'auto')).toBe(false);
    expect(asksForModel('make it fast', 'm', ['Fast lane'])).toBe(true);
    expect(asksForModel('use the local one', 'm', ['Local'])).toBe(false);
  });
});
