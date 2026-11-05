/**
 * The approval TTL sweep: session-less approvals (runner pairing) expire too,
 * through their own handler, and the returned count is what was actually
 * denied, not everything that was looked at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const written = vi.hoisted(() => [] as Array<{ content: string }>);
vi.mock('../../session-manager.js', async (orig) => ({
  ...(await orig<object>()),
  writeSessionMessage: vi.fn(async (_ag: string, _s: string, m: { content: string }) => {
    written.push(m);
  }),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => {}) }));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';

import { EXPIRY_USER, registerResendSurface, sweepExpiredApprovals, sweepStaleExpiredApprovals } from './expiry.js';
import { registerApprovalResolvedHandler, type ApprovalResolvedEvent } from './primitive.js';
import {
  __resetSessionlessApprovalsForTest,
  registerSessionlessApprovalHandler,
  type SessionlessApprovalContext,
} from './sessionless.js';

const DAY = 24 * 60 * 60 * 1000;

async function sessionlessRow(action: string, ageMs: number): Promise<string> {
  const id = `appr-exp-${Math.random().toString(36).slice(2, 8)}`;
  await createPendingApproval({
    approval_id: id,
    session_id: null,
    request_id: id,
    action,
    payload: '{}',
    created_at: new Date(Date.now() - ageMs).toISOString(),
    instance: null,
    title: 't',
    question: 'q',
    options_json: '[]',
    approver_user_id: null,
  });
  return id;
}

describe('sweepExpiredApprovals', () => {
  beforeEach(async () => {
    await initTestDb();
    await runMigrations(getDb());
    __resetSessionlessApprovalsForTest();
    delete process.env.NANOCLAW_APPROVAL_TTL_HOURS;
  });
  afterEach(async () => {
    await closeDb();
  });

  it('rejects an overdue session-less approval through its handler', async () => {
    const handler = vi.fn(async (_ctx: SessionlessApprovalContext) => {});
    registerSessionlessApprovalHandler('pair_test', handler);
    const old = await sessionlessRow('pair_test', 2 * DAY);
    const fresh = await sessionlessRow('pair_test', 60_000);

    expect(await sweepExpiredApprovals()).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ outcome: 'reject', userId: 'system:expiry' });
    expect(await getPendingApproval(old)).toBeUndefined();
    expect(await getPendingApproval(fresh)).toBeDefined();
  });

  it('does not count an approval it could not deny', async () => {
    const orphan = await sessionlessRow('nobody_home', 2 * DAY);
    expect(await sweepExpiredApprovals()).toBe(0);
    expect(await getPendingApproval(orphan)).toBeDefined();
  });
});

describe('an expired session approval', () => {
  const resolved: ApprovalResolvedEvent[] = [];
  registerApprovalResolvedHandler((e) => {
    resolved.push(e);
  });

  beforeEach(async () => {
    await initTestDb();
    await runMigrations(getDb());
    delete process.env.NANOCLAW_APPROVAL_TTL_HOURS;
    written.length = 0;
    resolved.length = 0;
    const now = new Date().toISOString();
    await createAgentGroup({ id: 'ag-1', name: 'Calendar', folder: 'cal', agent_provider: null, created_at: now });
    await createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now,
    });
  });
  afterEach(async () => {
    registerResendSurface(null);
    await closeDb();
  });

  async function cliRow(ageMs: number): Promise<string> {
    const id = `appr-cli-${Math.random().toString(36).slice(2, 8)}`;
    await createPendingApproval({
      approval_id: id,
      session_id: 'sess-1',
      request_id: id,
      action: 'cli_command',
      payload: JSON.stringify({ frame: { id: 'f', command: 'workloads-up', args: {} } }),
      created_at: new Date(Date.now() - ageMs).toISOString(),
      title: 'Deploy workload homeboard',
      question: 'q',
      options_json: '[]',
    });
    return id;
  }

  it('turns expired (kept for Send again), not rejected, and tells the agent plainly', async () => {
    registerResendSurface(async () => true);
    const id = await cliRow(2 * DAY);
    expect(await sweepExpiredApprovals()).toBe(1);

    expect((await getPendingApproval(id))?.status).toBe('expired');
    const text = JSON.parse(written[0].content).text as string;
    expect(text).toContain(
      'Your approval request for `ncl workloads-up` expired: nobody answered within 24 hours, so it did not run.',
    );
    expect(text).toContain('"Send again"');
    expect(text).not.toMatch(/rejected by admin/);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].userId).toBe(EXPIRY_USER);

    // A second sweep does nothing more.
    expect(await sweepExpiredApprovals()).toBe(0);
    expect(written).toHaveLength(1);
  });

  it('tells the agent to ask again itself where nobody can send it again', async () => {
    await cliRow(2 * DAY);
    await sweepExpiredApprovals();
    expect(JSON.parse(written[0].content).text).toContain("If it's still wanted, make the request again.");
  });

  it('drops expired rows once they can no longer be sent again', async () => {
    const old = await cliRow(10 * DAY);
    const recent = await cliRow(2 * DAY);
    await getDb().run(`UPDATE pending_approvals SET status = 'expired'`);
    expect(await sweepStaleExpiredApprovals()).toBe(1);
    expect(await getPendingApproval(old)).toBeUndefined();
    expect(await getPendingApproval(recent)).toBeDefined();
  });
});
