import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createPendingApproval, getPendingApproval } from '../../db/sessions.js';

import {
  __resetSessionlessApprovalsForTest,
  registerSessionlessApprovalHandler,
  resolveSessionlessApproval,
  type SessionlessApprovalContext,
} from './sessionless.js';

async function pendingRow(action: string, payload: Record<string, unknown>) {
  const id = `appr-t-${Math.random().toString(36).slice(2, 8)}`;
  await createPendingApproval({
    approval_id: id,
    session_id: null,
    request_id: id,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    instance: null,
    title: 't',
    question: 'q',
    options_json: '[]',
    approver_user_id: null,
  });
  return (await getPendingApproval(id))!;
}

describe('session-less approvals', () => {
  beforeEach(async () => {
    await initTestDb();
    await runMigrations(getDb());
    __resetSessionlessApprovalsForTest();
  });
  afterEach(async () => {
    await closeDb();
  });

  it('is not claimed when no handler owns the action', async () => {
    const row = await pendingRow('nobody_home', {});
    expect(await resolveSessionlessApproval(row, 'approve', 'webchat:owner')).toBe(false);
    expect(await getPendingApproval(row.approval_id)).toBeDefined(); // the dispatcher decides what to do with it
  });

  it('approve runs the handler once with the parsed payload and deletes the row; a repeat click is a no-op', async () => {
    const handler = vi.fn(async (_ctx: SessionlessApprovalContext) => {});
    registerSessionlessApprovalHandler('pair_test', handler);
    const row = await pendingRow('pair_test', { fingerprint: 'fp' });
    expect(await resolveSessionlessApproval(row, 'approve', 'webchat:owner')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      outcome: 'approve',
      userId: 'webchat:owner',
      payload: { fingerprint: 'fp' },
    });
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
    expect(await resolveSessionlessApproval(row, 'approve', 'webchat:owner')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('any other option is a reject, including reject-with-reason; the row is deleted even if the handler throws', async () => {
    const seen: string[] = [];
    registerSessionlessApprovalHandler('pair_test', async ({ outcome }) => {
      seen.push(outcome);
      throw new Error('handler exploded');
    });
    const row = await pendingRow('pair_test', {});
    await expect(resolveSessionlessApproval(row, 'reject_with_reason', 'webchat:owner')).rejects.toThrow(
      'handler exploded',
    );
    expect(seen).toEqual(['reject']);
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
  });
});
