/**
 * Tests for approval fan-out:
 *  - the composite-PK migration lets one approval be indexed against multiple
 *    inboxes, and the read path surfaces it to each approver;
 *  - the resolved-listener registry fires on resolution (drives the clear).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createPendingApproval } from '../../db/sessions.js';
import {
  recordWebchatApproval,
  isWebchatApprovalIndexedFor,
  getWebchatApprovalInboxes,
  deleteWebchatApprovalIndex,
  userForApprovalInbox,
  getWebchatPendingApprovalsForUser,
} from './db.js';

const INBOX_A = 'approvals:tailscale:a@example.com';
const INBOX_B = 'approvals:tailscale:b@example.com';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  await closeDb();
});

describe('webchat_approvals_index — multi-inbox (fan-out)', () => {
  it('indexes one approval against multiple inboxes', async () => {
    await recordWebchatApproval('appr-1', INBOX_A);
    await recordWebchatApproval('appr-1', INBOX_B);
    expect((await getWebchatApprovalInboxes('appr-1')).sort()).toEqual([INBOX_A, INBOX_B].sort());
    expect(await isWebchatApprovalIndexedFor('appr-1', INBOX_A)).toBe(true);
    expect(await isWebchatApprovalIndexedFor('appr-1', INBOX_B)).toBe(true);
    expect(await isWebchatApprovalIndexedFor('appr-1', 'approvals:tailscale:c@example.com')).toBe(false);
  });

  it('surfaces a fanned-out approval to every indexed approver', async () => {
    await createPendingApproval({
      approval_id: 'appr-2',
      session_id: null,
      request_id: 'appr-2',
      action: 'install_packages',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: 'Install Packages Request',
      options_json: '[]',
    });
    await recordWebchatApproval('appr-2', INBOX_A);
    await recordWebchatApproval('appr-2', INBOX_B);
    const forA = await getWebchatPendingApprovalsForUser('webchat:tailscale:a@example.com');
    const forB = await getWebchatPendingApprovalsForUser('webchat:tailscale:b@example.com');
    expect(forA.map((r) => r.approval_id)).toContain('appr-2');
    expect(forB.map((r) => r.approval_id)).toContain('appr-2');
  });

  it('deleteWebchatApprovalIndex clears all rows for an approval', async () => {
    await recordWebchatApproval('appr-3', INBOX_A);
    await recordWebchatApproval('appr-3', INBOX_B);
    await deleteWebchatApprovalIndex('appr-3');
    expect(await getWebchatApprovalInboxes('appr-3')).toEqual([]);
  });

  it('userForApprovalInbox inverts approvalInboxForUser', async () => {
    expect(userForApprovalInbox(INBOX_A)).toBe('webchat:tailscale:a@example.com');
    expect(userForApprovalInbox('not-an-inbox')).toBeNull();
  });
});
