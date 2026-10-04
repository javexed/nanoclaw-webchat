/**
 * restartAgentGroupContainersWhenIdle — a skill change must not kill a turn in
 * progress. Follow-ups pushed into a live query are already acked, so a
 * mid-turn kill loses them; the restart waits for the turn to end instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  claims: 0,
  running: true,
  feed: null as string | null,
  heartbeat: '',
}));

vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./container-restart.js', () => ({ restartAgentGroupContainers: vi.fn(async () => 1) }));
vi.mock('./container-runner.js', () => ({ isContainerRunning: () => state.running }));
vi.mock('./db/sessions.js', () => ({
  getSessionsByAgentGroup: vi.fn(async () => [{ id: 's1', agent_group_id: 'ag-1', status: 'active' }]),
}));
vi.mock('./session-manager.js', () => ({
  heartbeatPath: () => state.heartbeat,
  withExistingMailboxSession: async (_g: string, _s: string, fn: (m: unknown) => unknown) =>
    fn({ getProcessingClaims: () => Array.from({ length: state.claims }, (_, i) => ({ messageId: `m${i}` })) }),
}));
vi.mock('./session-db-access.js', () => ({
  openOutboundDb: () => {
    const db = new Database(':memory:');
    if (state.feed !== null) {
      db.exec('CREATE TABLE status_events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL)');
      db.prepare('INSERT INTO status_events (kind) VALUES (?)').run(state.feed);
    }
    return db;
  },
}));

import { restartAgentGroupContainers } from './container-restart.js';
import {
  _hasDeferredRestartForTesting,
  _resetDeferredRestartsForTesting,
  restartAgentGroupContainersWhenIdle,
  restartForModelSwitch,
  sessionInTurn,
} from './container-restart-idle.js';

const restart = vi.mocked(restartAgentGroupContainers);
let tmp: string;

function heartbeatAgo(ms: number): void {
  fs.writeFileSync(state.heartbeat, '');
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(state.heartbeat, t, t);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  restart.mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-idle-'));
  state.heartbeat = path.join(tmp, '.heartbeat');
  state.claims = 0;
  state.running = true;
  state.feed = 'done';
  heartbeatAgo(10 * 60 * 1000);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  _resetDeferredRestartsForTesting();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function nextPoll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000);
}

describe('restartAgentGroupContainersWhenIdle', () => {
  it('restarts at once when no turn is in progress', async () => {
    expect(await restartAgentGroupContainersWhenIdle('ag-1', 'Webchat learned skill kept')).toBe(1);
    expect(restart).toHaveBeenCalledWith('ag-1', 'Webchat learned skill kept');
  });

  it('waits for a claimed batch to finish, then restarts once', async () => {
    state.claims = 1;
    expect(await restartAgentGroupContainersWhenIdle('ag-1', 'Webchat learned skill kept')).toBe(1);
    expect(restart).not.toHaveBeenCalled();
    await nextPoll();
    expect(restart).not.toHaveBeenCalled();

    state.claims = 0;
    await nextPoll();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith('ag-1', 'Webchat learned skill kept');
    expect(_hasDeferredRestartForTesting('ag-1')).toBe(false);
  });

  it('treats a pushed follow-up (open status feed, no claims) as a turn in progress', async () => {
    state.feed = 'tool';
    await restartAgentGroupContainersWhenIdle('ag-1', 'Webchat learned skill kept');
    expect(restart).not.toHaveBeenCalled();
    state.feed = 'done';
    await nextPoll();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('treats recent provider activity as a turn in progress', async () => {
    heartbeatAgo(1_000);
    await restartAgentGroupContainersWhenIdle('ag-1', 'Webchat learned skill kept');
    expect(restart).not.toHaveBeenCalled();
  });

  it('folds changes made while waiting into the one restart', async () => {
    state.claims = 1;
    await restartAgentGroupContainersWhenIdle('ag-1', 'Webchat learned skill kept');
    await restartAgentGroupContainersWhenIdle('ag-1', 'Scoped skill x edited');
    state.claims = 0;
    await nextPoll();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith('ag-1', 'Webchat learned skill kept; Scoped skill x edited');
  });

  it('skips the restart when the containers exited while it waited', async () => {
    state.claims = 1;
    await restartAgentGroupContainersWhenIdle('ag-1', 'Webchat learned skill kept');
    state.running = false;
    await nextPoll();
    expect(restart).not.toHaveBeenCalled();
    expect(_hasDeferredRestartForTesting('ag-1')).toBe(false);
  });

  it('gives up waiting after the cap and restarts anyway', async () => {
    state.claims = 1;
    await restartAgentGroupContainersWhenIdle('ag-1', 'Webchat learned skill kept');
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('sessionInTurn', () => {
  it('is idle only with no claims, a closed feed and a quiet heartbeat', () => {
    expect(sessionInTurn({ claims: 0, lastStatusKind: 'done', heartbeatAgeMs: 60_000 })).toBe(false);
    expect(sessionInTurn({ claims: 0, lastStatusKind: null, heartbeatAgeMs: Infinity })).toBe(false);
    expect(sessionInTurn({ claims: 2, lastStatusKind: 'done', heartbeatAgeMs: 60_000 })).toBe(true);
    expect(sessionInTurn({ claims: 0, lastStatusKind: 'start', heartbeatAgeMs: 60_000 })).toBe(true);
    expect(sessionInTurn({ claims: 0, lastStatusKind: 'done', heartbeatAgeMs: 2_000 })).toBe(true);
  });
});

describe('restartForModelSwitch', () => {
  it('waits for the turn in progress before restarting on the new model', async () => {
    state.claims = 1;
    expect(await restartForModelSwitch('ag-1', 'qwen3:8b', 'gemma3:4b')).toMatch(/no `ncl groups restart` needed/);
    expect(restart).not.toHaveBeenCalled();
    state.claims = 0;
    await nextPoll();
    expect(restart).toHaveBeenCalledWith('ag-1', 'model switched via ncl');
  });

  it('restarts nothing when the model did not change', async () => {
    expect(await restartForModelSwitch('ag-1', 'qwen3:8b', 'qwen3:8b')).toBeNull();
    expect(await restartForModelSwitch('ag-1', null, '')).toBeNull();
    expect(restart).not.toHaveBeenCalled();
    expect(_hasDeferredRestartForTesting('ag-1')).toBe(false);
  });
});
