import { describe, expect, it } from 'vitest';

import { approvalNoticeView, canActOn, roomApprovalView } from './approval-row.js';

const OWNER = 'webchat:tailscale:alice@example.com';
const card = (extra: Record<string, unknown> = {}, message_type = 'approval') => ({
  id: 'appr-card-appr-1',
  message_type,
  content: JSON.stringify({
    questionId: 'appr-1',
    title: 'Deploy workload homeboard',
    question: 'q',
    options: [{ label: 'Approve', value: 'approve' }],
    approvers: [OWNER],
    approverNames: ['Alice (owner)'],
    approverIdentities: ['Alice A.'],
    ...extra,
  }),
});

describe('who may act on an in-room card', () => {
  it('the approver, known by the identity they signed in with, gets the actionable card', () => {
    expect(roomApprovalView(card(), 'Alice A.').state).toBe('eligible');
  });

  it('an older card matches the identity its approver id ends with (never the whole id: the bug)', () => {
    expect(canActOn([OWNER], undefined, 'alice@example.com')).toBe(true);
    expect(canActOn([OWNER], undefined, 'bob@example.com')).toBe(false);
    expect(canActOn([OWNER], undefined, '')).toBe(false);
  });

  it('everyone else sees whom it waits for, read-only', () => {
    const v = roomApprovalView(card(), 'bob@example.com');
    expect(v.state).toBe('awaiting');
    expect(v.note).toBe('🔒 Deploy workload homeboard — waiting for Alice');
  });
});

describe('a resolved in-room card', () => {
  it('approved: who, and the outcome line with its details', () => {
    const v = roomApprovalView(
      card(
        {
          resolvedBy: OWNER,
          resolvedByName: 'Alice',
          outcome: 'approved',
          result: {
            line: 'Approved and done. Deployed "homeboard": running.',
            outcome: 'Deployed "homeboard": running.',
            details: '{}',
            failed: false,
          },
        },
        'approval_resolved',
      ),
      'Alice A.',
    );
    expect(v.state).toBe('approved');
    expect(v.note).toBe('✅ Deploy workload homeboard — approved by Alice');
    expect(v.result?.line).toBe('Deployed "homeboard": running.');
  });

  it('rejected and expired say which', () => {
    expect(
      roomApprovalView(card({ resolvedBy: OWNER, outcome: 'rejected' }, 'approval_resolved'), 'Alice A.').note,
    ).toBe('❌ Deploy workload homeboard — rejected by alice');
    expect(
      roomApprovalView(card({ resolvedBy: 'system:expiry', outcome: 'expired' }, 'approval_resolved'), 'Alice A.').note,
    ).toBe('⏱ Deploy workload homeboard — expired');
  });

  it('an older row with only who resolved it still reads', () => {
    expect(roomApprovalView(card({ resolvedBy: OWNER }, 'approval_resolved'), 'Alice A.').state).toBe('resolved');
  });
});

describe('approval notices', () => {
  it('an expired notice offers Send again until someone has', () => {
    const n = approvalNoticeView({
      content: JSON.stringify({ questionId: 'appr-1', kind: 'expired', text: 'Expired.' }),
    });
    expect(n).toEqual({ questionId: 'appr-1', kind: 'expired', text: 'Expired.', resentByName: null });
    const sent = approvalNoticeView({
      content: JSON.stringify({
        questionId: 'appr-1',
        kind: 'expired',
        text: 'Expired.',
        resentBy: OWNER,
        resentByName: 'Alice',
      }),
    });
    expect(sent.resentByName).toBe('Alice');
  });
});
