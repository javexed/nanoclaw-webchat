/**
 * Where a task's alerts go: the chat it came from, else the approver chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  groups: new Map<string, unknown>(),
  dm: null as unknown,
  deliver: vi.fn(async () => 'msg-1'),
  adapter: true,
}));

vi.mock('../../db/sessions.js', () => ({ getSession: async (id: string) => state.sessions.get(id) }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: async (id: string) => state.groups.get(id) }));
vi.mock('../approvals/primitive.js', () => ({
  pickApprover: async () => ['webchat:owner'],
  pickApprovalDelivery: async () => (state.dm ? { userId: 'webchat:owner', messagingGroup: state.dm } : null),
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => (state.adapter ? { deliver: state.deliver } : null),
}));
vi.mock('../../container-config.js', () => ({ resolveGroupTimezone: async () => 'UTC' }));

import { resolveAlertTarget, sendAlert } from './notify.js';

const alert = {
  kind: 'opened' as const,
  seriesId: 'daily-brief-1a2b',
  signature: 'model-error',
  reason: 'boom',
  failures: 1,
  openedAt: '2026-10-01T09:00:00.000Z',
};

beforeEach(() => {
  state.sessions = new Map([
    ['sess-room', { id: 'sess-room', agent_group_id: 'ag-1', messaging_group_id: 'mg-room', thread_id: 'th-1' }],
    ['sess-other', { id: 'sess-other', agent_group_id: 'ag-2', messaging_group_id: 'mg-room', thread_id: null }],
  ]);
  state.groups = new Map([['mg-room', { channel_type: 'webchat', platform_id: 'room-1', instance: 'webchat' }]]);
  state.dm = { channel_type: 'telegram', platform_id: 'dm-9', instance: 'telegram' };
  state.deliver.mockClear();
  state.adapter = true;
});

describe('resolveAlertTarget', () => {
  it('prefers the chat and thread the task was created from', async () => {
    expect(await resolveAlertTarget('ag-1', 'sess-room')).toEqual({
      channelType: 'webchat',
      platformId: 'room-1',
      threadId: 'th-1',
      instance: 'webchat',
    });
  });

  it("falls back to the approvers' DM: no origin, a vanished origin, or another group's session", async () => {
    const dm = { channelType: 'telegram', platformId: 'dm-9', threadId: null, instance: 'telegram' };
    expect(await resolveAlertTarget('ag-1', null)).toEqual(dm);
    expect(await resolveAlertTarget('ag-1', 'sess-gone')).toEqual(dm);
    expect(await resolveAlertTarget('ag-1', 'sess-other')).toEqual(dm);
  });

  it('returns null when nobody is reachable', async () => {
    state.dm = null;
    expect(await resolveAlertTarget('ag-1', null)).toBeNull();
  });
});

describe('sendAlert', () => {
  it('delivers the alert text as a chat message', async () => {
    expect(await sendAlert(alert, 'ag-1', 'sess-room')).toBe(true);
    expect(state.deliver).toHaveBeenCalledWith(
      'webchat',
      'room-1',
      'th-1',
      'chat',
      JSON.stringify({ text: 'Scheduled task daily-brief-1a2b failed: boom' }),
      undefined,
      'webchat',
    );
  });

  it('never throws: no adapter, no target, or a failing deliver all return false', async () => {
    state.adapter = false;
    expect(await sendAlert(alert, 'ag-1', 'sess-room')).toBe(false);
    state.adapter = true;
    state.dm = null;
    expect(await sendAlert(alert, 'ag-1', null)).toBe(false);
    state.deliver.mockRejectedValueOnce(new Error('offline'));
    expect(await sendAlert(alert, 'ag-1', 'sess-room')).toBe(false);
  });
});
