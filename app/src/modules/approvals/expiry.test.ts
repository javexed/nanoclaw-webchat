/**
 * The approval TTL sweep: session-less approvals (runner pairing) expire too,
 * through their own handler, and the returned count is what was actually
 * denied, not everything that was looked at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createPendingApproval, getPendingApproval } from '../../db/sessions.js';

import { sweepExpiredApprovals } from './expiry.js';
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
