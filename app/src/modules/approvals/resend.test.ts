/**
 * "Send again" on an expired approval: the identical request goes back
 * through the path it first took (dispatch for `ncl`, requestApproval for a
 * module action), exactly once, and only for an expired row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock('../../cli/dispatch.js', () => ({ dispatch: dispatchMock }));
const primitive = vi.hoisted(() => ({ notifyAgent: vi.fn(async () => {}), requestApproval: vi.fn(async () => {}) }));
vi.mock('./primitive.js', async (orig) => ({ ...(await orig<object>()), ...primitive }));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';
import { resendExpiredApproval } from './resend.js';

const now = () => new Date().toISOString();
const CTX = { caller: 'agent', sessionId: 'sess-1', agentGroupId: 'ag-1', messagingGroupId: 'mg-1' };
const FRAME = {
  id: 'cli-1',
  command: 'workloads-up',
  args: { name: 'homeboard', file: 'dash/compose.yml', approved: 'old-pin' },
};

async function row(
  id: string,
  status: string,
  action = 'cli_command',
  payload: unknown = { frame: FRAME, callerContext: CTX },
) {
  await createPendingApproval({
    approval_id: id,
    session_id: 'sess-1',
    request_id: id,
    action,
    payload: JSON.stringify(payload),
    created_at: now(),
    title: 'Deploy workload homeboard',
    question: 'q',
    options_json: '[]',
  });
  await getDb().run(`UPDATE pending_approvals SET status = ? WHERE approval_id = ?`, status, id);
}

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  await createAgentGroup({ id: 'ag-1', name: 'Calendar', folder: 'cal', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'webchat',
    platform_id: 'calendar',
    name: 'Calendar',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  dispatchMock.mockReset();
  primitive.notifyAgent.mockClear();
  primitive.requestApproval.mockClear();
});
afterEach(async () => {
  await closeDb();
});

describe('resendExpiredApproval', () => {
  it('replays an expired ncl command through dispatch as the agent that asked, once', async () => {
    await row('appr-x', 'expired');
    dispatchMock.mockResolvedValue({
      id: 'x',
      ok: false,
      error: { code: 'approval-pending', message: 'Approval card posted.' },
    });

    const r = await resendExpiredApproval('appr-x', 'webchat:tailscale:alice@example.com');
    expect(r).toEqual({ ok: true, note: 'Sent again.' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [sentFrame, sentCtx] = dispatchMock.mock.calls[0];
    expect(sentFrame.command).toBe('workloads-up');
    // The same arguments: the precheck re-pins on the way through dispatch.
    expect(sentFrame.args).toEqual(FRAME.args);
    expect(sentCtx).toEqual(CTX);
    expect(await getPendingApproval('appr-x')).toBeUndefined();
    expect(primitive.notifyAgent).toHaveBeenCalledWith(
      expect.anything(),
      'Alice sent your expired request for `ncl workloads-up` again. Approval card posted.',
    );

    // A second click finds nothing to send.
    const again = await resendExpiredApproval('appr-x', 'webchat:tailscale:alice@example.com');
    expect(again.ok).toBe(false);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a request that is still pending (only an expired one can be sent again)', async () => {
    await row('appr-p', 'pending');
    const r = await resendExpiredApproval('appr-p', 'u');
    expect(r.ok).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(await getPendingApproval('appr-p')).toBeDefined();
  });

  it('says why when the re-run precheck refuses it, redacted', async () => {
    await row('appr-r', 'expired');
    dispatchMock.mockResolvedValue({
      id: 'x',
      ok: false,
      error: { code: 'handler-error', message: 'stack refused: see https://h.example/x?Signature=abcdef123456' },
    });
    const r = await resendExpiredApproval('appr-r', 'u');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('stack refused');
      expect(r.reason).not.toContain('abcdef123456');
    }
  });

  it('re-issues a module approval through requestApproval with the same action and card', async () => {
    await row('appr-m', 'expired', 'install_packages', { apt: ['jq'] });
    const r = await resendExpiredApproval('appr-m', 'u');
    expect(r.ok).toBe(true);
    expect(primitive.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'install_packages',
        payload: { apt: ['jq'] },
        title: 'Deploy workload homeboard',
        question: 'q',
        agentName: 'Calendar',
      }),
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
