/**
 * killContainer issues one stop per runtime. Every docker event re-runs the
 * session reconcile, so a kill that is still in flight used to be re-issued
 * several times a second, each racing the first stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupervisedHandle, SupervisedSnapshot } from './drivers/session-events.js';

const snapshots: SupervisedSnapshot[] = [];
vi.mock('./drivers/index.js', () => ({
  getSessionDriver: () => ({
    listSessions: async () => snapshots,
    capabilities: () => ({}),
  }),
  isSessionEventsDriver: () => false,
}));

import {
  _setFinishFenceScheduleForTesting,
  adoptRunningSessions,
  isContainerRunning,
  isContainerStopping,
  killContainer,
} from './container-runner.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from './db/index.js';
import { type GatewaySessionInput, resetGatewayProvider } from './gateway-providers/index.js';

const ensure = vi.fn(async (_input: GatewaySessionInput) => ({
  contribution: {
    networkAccess: { endpoint: 'http://proxy:8080', target: { kind: 'runtime' as const, identity: 'proxy' } },
  },
  release: async () => {},
}));

const now = (): string => new Date().toISOString();

/** A handle whose first stop() stays pending until the test settles it; later stops resolve at once. */
function gatedHandle() {
  const terminal: Array<(failure?: unknown) => void> = [];
  let settle: (err?: Error) => void = () => {};
  let gated = true;
  const stop = vi.fn(async (): Promise<void> => {
    if (!gated) return;
    gated = false;
    await new Promise<void>((resolve, reject) => {
      settle = (err) => {
        if (err) return reject(err);
        for (const cb of terminal) cb(undefined);
        resolve();
      };
    });
  });
  const handle = {
    key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId: 'sess-1' },
    name: 'container-a',
    async start() {},
    stop,
    async status() {
      return { phase: 'running' };
    },
    onTerminal(cb: (failure?: unknown) => void) {
      terminal.push(cb);
    },
  } as unknown as SupervisedHandle;
  return { handle, stop, settle: (err?: Error) => settle(err) };
}

beforeEach(async () => {
  snapshots.length = 0;
  resetGatewayProvider({
    kind: 'test-stop-once',
    agentSkills: [],
    sessions: { ensure, reapOrphans: async () => {} },
    approvals: { subscribe: async () => {} },
  });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
});

afterEach(async () => {
  _setFinishFenceScheduleForTesting();
  resetGatewayProvider();
  await closeDb();
});

describe('killContainer — one stop per runtime', () => {
  it('a repeated kill while the first stop is in flight does not stop again, but its callback still fires', async () => {
    const { handle, stop, settle } = gatedHandle();
    snapshots.push({ handle, phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    expect(isContainerStopping('sess-1')).toBe(false);

    const exited: string[] = [];
    killContainer('sess-1', 'absolute-ceiling');
    killContainer('sess-1', 'absolute-ceiling');
    killContainer('sess-1', 'restart', () => exited.push('restart'));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(isContainerStopping('sess-1')).toBe(true);

    settle();
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
    expect(exited).toEqual(['restart']);
    expect(isContainerStopping('sess-1')).toBe(false);
  });

  it('a runtime whose teardown failed stays "stopping" and is not re-killed by later calls', async () => {
    _setFinishFenceScheduleForTesting([], 60_000);
    const { handle, stop, settle } = gatedHandle();
    snapshots.push({ handle, phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();

    killContainer('sess-1', 'absolute-ceiling');
    stop.mockImplementation(async () => {
      throw new Error('removal failed');
    });
    settle(new Error('removal failed'));
    // finish() retries the stop once on its own and then defers.
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
    const callsAfterTeardownFailed = stop.mock.calls.length;

    killContainer('sess-1', 'absolute-ceiling');
    killContainer('sess-1', 'absolute-ceiling');
    expect(stop).toHaveBeenCalledTimes(callsAfterTeardownFailed);
    expect(isContainerStopping('sess-1')).toBe(true);
    expect(isContainerRunning('sess-1')).toBe(true);
  });
});
