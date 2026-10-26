/**
 * The reconcile runs the task-run policy for a task session BEFORE it counts
 * due messages: a run that died is still pending, and only a verdict reached
 * first keeps the wake from simply running it again. Other sessions never
 * load the policy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ order: [] as string[], threadId: null as string | null }));

vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./db/sessions.js', () => ({
  getSession: vi.fn(async (id: string) => ({
    id,
    agent_group_id: 'ag-1',
    thread_id: state.threadId,
    status: 'active',
  })),
  isTaskThread: (t: string | null) => !!t && t.startsWith('system:tasks:'),
  updateSession: vi.fn(),
}));
vi.mock('./db/agent-groups.js', () => ({ getAgentGroup: vi.fn(async () => ({ id: 'ag-1' })) }));
vi.mock('./db/coordination.js', () => ({ getSessionClaim: vi.fn(async () => null) }));
vi.mock('./session-manager.js', () => ({
  heartbeatPath: () => '/nonexistent/heartbeat',
  withExistingMailboxSession: async (_g: string, _s: string, fn: (m: unknown) => unknown) => fn(fakeMailbox()),
}));
vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: () => undefined,
  isContainerRunning: () => false,
  isContainerStopping: () => false,
  killContainer: vi.fn(),
}));
vi.mock('./request-wake.js', () => ({ requestWake: vi.fn() }));
vi.mock('./modules/scheduling/recurrence.js', () => ({ handleRecurrence: vi.fn() }));
vi.mock('./modules/cross-session-context/index.js', () => ({ pruneEchoBacklog: () => 0 }));
vi.mock('./modules/task-health/index.js', () => ({
  applyTaskRunPolicy: vi.fn(async () => {
    state.order.push('policy');
  }),
}));

import { applyTaskRunPolicy } from './modules/task-health/index.js';
import { reconcileSession } from './reconcile-session.js';

function fakeMailbox() {
  return {
    applyProcessingAcks: () => {},
    getTerminalProcessingAcks: () => [],
    countDueMessages: () => {
      state.order.push('count-due');
      return 0;
    },
    getProcessingClaims: () => [],
    getMessageForRetry: () => null,
    deleteOrphanProcessingClaims: () => 0,
    countLiveTasks: () => 1,
  };
}

beforeEach(() => {
  state.order = [];
  vi.mocked(applyTaskRunPolicy).mockClear();
});

describe('reconcile → task-run policy', () => {
  it('runs the policy for a task session before counting due messages', async () => {
    state.threadId = 'system:tasks:daily-brief-1a2b';
    await reconcileSession('sess-task');
    expect(applyTaskRunPolicy).toHaveBeenCalledTimes(1);
    expect(state.order).toEqual(['policy', 'count-due']);
  });

  it('leaves every other session alone', async () => {
    state.threadId = null;
    await reconcileSession('sess-room');
    expect(applyTaskRunPolicy).not.toHaveBeenCalled();
  });
});
