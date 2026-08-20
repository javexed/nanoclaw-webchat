/**
 * Tests for the per-user approvals inbox primitives.
 *
 * Webchat's openDM path produces synthetic `approvals:<handle>`
 * platform_ids. To find "approvals for this user" without depending on a
 * trunk-side stamp on `pending_approvals.platform_id`, the skill
 * maintains its own `webchat_approvals_index` table — webchat's
 * `deliver()` writes to it when an approval lands on a webchat
 * approval-inbox, and the inbox query JOINs against it.
 */
import { randomUUID } from 'crypto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  APPROVAL_INBOX_PREFIX,
  approvalInboxForUser,
  getAllWebchatRooms,
  getWebchatPendingApprovalsForUser,
  isApprovalInbox,
  recordWebchatApproval,
} from './db.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  await closeDb();
});

async function insertRoomLikeMessagingGroup(platformId: string, name: string): Promise<void> {
  await getDb().run(`INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'webchat', 'webchat', ?, ?, 0, 'public', ?)`, randomUUID(), platformId, name, new Date().toISOString());
}

async function insertPendingApproval(opts: {
  approvalId: string;
  platformId: string | null;
  status?: string;
  action?: string;
  title?: string;
}): Promise<void> {
  // Insert the approval row exactly the way trunk's requestApproval would
  // — without the platform_id stamp (those columns stay NULL on real
  // installs because trunk's primitive doesn't populate them).
  await getDb().run(`INSERT INTO pending_approvals
         (approval_id, session_id, request_id, action, payload, created_at,
          agent_group_id, channel_type, platform_id, platform_message_id,
          expires_at, status, title, options_json)
       VALUES
         (@approval_id, NULL, @approval_id, @action, '{}', @created_at,
          NULL, NULL, NULL, NULL,
          NULL, @status, @title, '[]')`, {
      approval_id: opts.approvalId,
      action: opts.action ?? 'install_packages',
      created_at: new Date().toISOString(),
      status: opts.status ?? 'pending',
      title: opts.title ?? 'Test Approval',
    });
  // If a platformId is provided, simulate the webchat deliver() path
  // that records the inbox mapping. Tests with platformId=null model
  // approvals delivered to a non-webchat channel — they correctly stay
  // out of the webchat inbox.
  if (opts.platformId !== null) {
    await recordWebchatApproval(opts.approvalId, opts.platformId);
  }
}

describe('approvalInboxForUser', () => {
  it('maps webchat user_ids to the approvals: platform_id', async () => {
    expect(approvalInboxForUser('webchat:tailscale:foo@example.com')).toBe('approvals:tailscale:foo@example.com');
  });

  it('returns null for non-webchat user_ids', async () => {
    expect(approvalInboxForUser('slack:U123')).toBeNull();
    expect(approvalInboxForUser('cli:local')).toBeNull();
  });
});

describe('isApprovalInbox', () => {
  it('matches the approvals: prefix', async () => {
    expect(isApprovalInbox(`${APPROVAL_INBOX_PREFIX}foo@example.com`)).toBe(true);
    expect(isApprovalInbox('cli-local')).toBe(false);
    expect(isApprovalInbox('approvals')).toBe(false); // no colon → not the prefix
  });
});

describe('getAllWebchatRooms hides approval inboxes', () => {
  it('filters platform_ids starting with approvals:', async () => {
    await insertRoomLikeMessagingGroup('cli-local', 'Real Room');
    await insertRoomLikeMessagingGroup('approvals:tailscale:foo@example.com', 'Hidden Inbox');

    const rooms = await getAllWebchatRooms();
    expect(rooms.map((r) => r.id)).toEqual(['cli-local']);
  });
});

describe('getWebchatPendingApprovalsForUser', () => {
  const userId = 'webchat:tailscale:owner@example.com';
  const platformId = 'approvals:tailscale:owner@example.com';

  it('returns only approvals stamped with this user platform_id', async () => {
    await insertPendingApproval({ approvalId: 'a-mine', platformId });
    await insertPendingApproval({ approvalId: 'a-other', platformId: 'approvals:tailscale:other@example.com' });
    await insertPendingApproval({ approvalId: 'a-noplat', platformId: null });

    const rows = await getWebchatPendingApprovalsForUser(userId);
    expect(rows.map((r) => r.approval_id)).toEqual(['a-mine']);
  });

  it('hides resolved approvals (status != pending)', async () => {
    await insertPendingApproval({ approvalId: 'a-pending', platformId });
    await insertPendingApproval({ approvalId: 'a-approved', platformId, status: 'approved' });
    await insertPendingApproval({ approvalId: 'a-rejected', platformId, status: 'rejected' });

    const rows = await getWebchatPendingApprovalsForUser(userId);
    expect(rows.map((r) => r.approval_id)).toEqual(['a-pending']);
  });

  it('returns nothing for non-webchat users', async () => {
    await insertPendingApproval({ approvalId: 'a-1', platformId: 'approvals:U123' });
    expect(await getWebchatPendingApprovalsForUser('slack:U123')).toEqual([]);
  });
});

describe('recordWebchatApproval idempotency', () => {
  it('composite key: same (approval_id, platform_id) is a no-op; a new inbox adds a row (fan-out)', async () => {
    const platformId = 'approvals:tailscale:foo@example.com';
    await recordWebchatApproval('a-dup', platformId);
    const before = (await getDb().get(`SELECT recorded_at FROM webchat_approvals_index WHERE approval_id = ? AND platform_id = ?`, 'a-dup', platformId)) as { recorded_at: number } | undefined;
    expect(before).toBeDefined();

    // Same (approval_id, platform_id) → OR IGNORE keeps the original row + time.
    await recordWebchatApproval('a-dup', platformId);
    // Same approval_id, DIFFERENT inbox → a second row (fan-out delivery).
    await recordWebchatApproval('a-dup', 'approvals:tailscale:other@example.com');

    const rows = (await getDb().all(`SELECT platform_id, recorded_at FROM webchat_approvals_index WHERE approval_id = ? ORDER BY platform_id`, 'a-dup')) as { platform_id: string; recorded_at: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.platform_id === platformId)!.recorded_at).toBe(before!.recorded_at);
    expect(rows.some((r) => r.platform_id === 'approvals:tailscale:other@example.com')).toBe(true);
  });
});
