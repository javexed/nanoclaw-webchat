/**
 * The in-room approval card's life after it is posted: who can act on it in
 * the room (the agent's "right here" vs Admin → Approvals), the names on it,
 * its resolved state (approved with the result's summary, rejected, expired),
 * the one reminder before it expires, the expired notice and "Send again".
 */
import { randomUUID } from 'crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { createPendingApproval, createSession } from '../../db/sessions.js';
import { EXPIRY_USER } from '../../modules/approvals/expiry.js';
import { grantRole } from '../../modules/permissions/db/user-roles.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { approvedResultWords } from '../../cli/registry.js';
import '../../modules/approvals/words.js';
import type { PendingApproval, Session } from '../../types.js';
import { storeWebchatApprovalCard } from './db.js';
import {
  approversInRoom,
  canResendApproval,
  cardAudience,
  expiredNotice,
  getApprovalCard,
  markNoticeResent,
  noticeId,
  patchApprovalCard,
  resolvedPatch,
  storeApprovalNotice,
  sweepApprovalReminders,
} from './inroom-approvals.js';
import { pushText } from './state.js';

const HOUR = 60 * 60 * 1000;
const OWNER = 'webchat:tailscale:alice.smith@example.com';
const OTHER_ADMIN = 'webchat:tailscale:bob@example.com';
const now = () => new Date().toISOString();

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  delete process.env.NANOCLAW_APPROVAL_TTL_HOURS;
  await createUser({ id: OWNER, kind: 'webchat', display_name: 'alice.smith@example.com', created_at: now() });
  await createUser({ id: OTHER_ADMIN, kind: 'webchat', display_name: 'bob@example.com', created_at: now() });
  await grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  await createAgentGroup({ id: 'ag-cal', name: 'Calendar', folder: 'cal', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-other', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
  // Bob administers another agent only: the calendar room is not his.
  await grantRole({
    user_id: OTHER_ADMIN,
    role: 'admin',
    agent_group_id: 'ag-other',
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-cal',
    channel_type: 'webchat',
    platform_id: 'calendar',
    name: 'Calendar',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: 'mg-cal',
    agent_group_id: 'ag-cal',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-cal',
    messaging_group_id: 'mg-cal',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-slack',
    channel_type: 'slack',
    platform_id: 'C1',
    name: 'Slack',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});
afterEach(() => closeDb());

async function postCard(approvalId: string, createdAt = Date.now()) {
  await createPendingApproval({
    approval_id: approvalId,
    session_id: 'sess-1',
    request_id: approvalId,
    action: 'cli_command',
    payload: '{}',
    created_at: new Date(createdAt).toISOString(),
    title: 'Deploy workload homeboard',
    question: 'q',
    options_json: '[]',
  });
  return storeWebchatApprovalCard(
    'calendar',
    'Calendar',
    {
      questionId: approvalId,
      title: 'Deploy workload homeboard',
      question: 'q',
      options: [],
      action: 'cli_command',
      approvers: [OWNER],
      ...(await cardAudience([OWNER], createdAt)),
    },
    'main',
  );
}

const content = (m: { content: string } | undefined) => JSON.parse(m!.content) as Record<string, unknown>;

describe('who can act on the card in the room', () => {
  it('lists the approvers who can open the room; null outside webchat', async () => {
    expect(await approversInRoom('mg-cal', [OWNER, OTHER_ADMIN])).toEqual([OWNER]);
    expect(await approversInRoom('mg-slack', [OWNER])).toBeNull();
  });

  it('the card names its approvers and when it expires', async () => {
    const t = Date.now();
    const c = content(await postCard('appr-1', t));
    expect(c.approvers).toEqual([OWNER]);
    expect(c.approverNames).toEqual(['Alice Smith (owner)']);
    expect(c.approverIdentities).toEqual(['alice.smith@example.com']);
    expect(c.expiresAt).toBe(t + 24 * HOUR);
  });
});

describe('resolved card', () => {
  const event = (outcome: 'approve' | 'reject', userId: string, id = 'appr-2') => ({
    approval: { approval_id: id, title: 'Deploy workload homeboard' } as PendingApproval,
    session: {} as Session,
    outcome,
    userId,
  });

  it('an approval carries who, and the outcome the agent was told', async () => {
    await postCard('appr-2');
    approvedResultWords({
      approvalId: 'appr-2',
      frame: { id: 'f', command: 'workloads-up', args: {} },
      response: {
        id: 'f',
        ok: true,
        data: { name: 'homeboard', state: 'running', services_private: { web: '198.18.0.10' } },
      },
    });
    const card = await patchApprovalCard('appr-2', await resolvedPatch(event('approve', OWNER)), 'approval_resolved');
    expect(card?.message_type).toBe('approval_resolved');
    const c = content(card);
    expect(c).toMatchObject({ outcome: 'approved', resolvedBy: OWNER, resolvedByName: 'Alice Smith' });
    expect((c.result as { line: string }).line).toBe(
      'Approved and done. Deployed "homeboard": running (web at 198.18.0.10).',
    );
    expect((c.result as { outcome: string }).outcome).toBe('Deployed "homeboard": running (web at 198.18.0.10).');
    // Persisted, so a reload renders the same.
    expect(content(await getApprovalCard('appr-2')).outcome).toBe('approved');
  });

  it('a rejection and an expiry say which they were', async () => {
    expect(await resolvedPatch(event('reject', OWNER))).toMatchObject({
      outcome: 'rejected',
      resolvedByName: 'Alice Smith',
    });
    expect(await resolvedPatch(event('reject', EXPIRY_USER))).toEqual({ resolvedBy: EXPIRY_USER, outcome: 'expired' });
  });
});

describe('reminder and expiry notices', () => {
  it('reminds the room once, about an hour before the card expires', async () => {
    await postCard('appr-old', Date.now() - 23.5 * HOUR);
    await postCard('appr-new', Date.now() - 2 * HOUR);
    const posted = await sweepApprovalReminders();
    expect(posted.map((m) => m.id)).toEqual([noticeId('reminder', 'appr-old')]);
    const n = content(posted[0]);
    expect(n).toMatchObject({ kind: 'reminder', questionId: 'appr-old' });
    expect(n.text).toBe('Approval for "Deploy workload homeboard" expires in 1 hour. Waiting for Alice Smith.');
    expect(posted[0].thread_id).toBe('main');
    expect(await sweepApprovalReminders()).toEqual([]);
  });

  it('does not remind about a card that is already resolved', async () => {
    await postCard('appr-done', Date.now() - 23.5 * HOUR);
    await patchApprovalCard('appr-done', { outcome: 'approved' }, 'approval_resolved');
    expect(await sweepApprovalReminders()).toEqual([]);
  });

  it('posts one expired notice, and records who sent it again', async () => {
    const card = (await postCard('appr-exp'))!;
    const notice = expiredNotice('appr-exp', 'Deploy workload homeboard');
    expect(notice.text).toBe(
      'Approval for "Deploy workload homeboard" expired: nobody answered within 24 hours, so it didn\'t run.',
    );
    expect(await storeApprovalNotice(card, notice)).not.toBeNull();
    expect(await storeApprovalNotice(card, notice)).toBeNull();
    const resent = await markNoticeResent('appr-exp', OWNER);
    expect(content(resent)).toMatchObject({ resentBy: OWNER, resentByName: 'Alice Smith' });
  });

  it('only someone who can open the room may send it again', async () => {
    await postCard('appr-room');
    expect(await canResendApproval(OWNER, 'appr-room')).toBe(true);
    expect(await canResendApproval(OTHER_ADMIN, 'appr-room')).toBe(false);
    expect(await canResendApproval(OWNER, 'appr-missing')).toBe(false);
  });

  it('a notice pushes its sentence, not its JSON', () => {
    expect(pushText({ message_type: 'approval_notice', content: JSON.stringify({ text: 'Expires in 1 hour.' }) })).toBe(
      'Expires in 1 hour.',
    );
    expect(pushText({ message_type: 'text', content: 'hi' })).toBe('hi');
  });
});
