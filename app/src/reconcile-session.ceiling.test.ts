/**
 * The absolute-ceiling path of the per-session reconcile: an idle container
 * reaped past the ceiling must not wipe the stored conversation, a stuck turn
 * killed twice still does (once per incarnation, and every time when the
 * incarnation is unknown), and a container already being stopped is left to
 * that stop rather than killed again on every reconcile.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  claims: [] as Array<{ messageId: string; statusChanged: string }>,
  startedAtMs: 0,
  incarnation: 1,
  /** Neither the claim's incarnation nor the container's start is known; an old heartbeat file ages it instead. */
  noIds: false,
  heartbeat: '/nonexistent/heartbeat',
  db: null as unknown as import('better-sqlite3').Database,
}));

vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./db/sessions.js', () => ({
  getSession: vi.fn(async (id: string) => ({ id, agent_group_id: 'ag-1', thread_id: null, status: 'active' })),
  isTaskThread: () => false,
  updateSession: vi.fn(),
}));
vi.mock('./db/agent-groups.js', () => ({ getAgentGroup: vi.fn(async () => ({ id: 'ag-1' })) }));
vi.mock('./db/coordination.js', () => ({
  getSessionClaim: vi.fn(async () =>
    state.noIds ? null : { incarnation: state.incarnation, claimed_at: new Date(state.startedAtMs).toISOString() },
  ),
}));
vi.mock('./session-manager.js', () => ({
  heartbeatPath: () => state.heartbeat,
  withExistingMailboxSession: async (_g: string, _s: string, fn: (m: unknown) => unknown) => fn(fakeMailbox()),
}));
vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: () => (state.noIds ? undefined : state.startedAtMs),
  isContainerRunning: () => true,
  isContainerStopping: vi.fn(() => false),
  killContainer: vi.fn(),
}));
vi.mock('./request-wake.js', () => ({ requestWake: vi.fn() }));
vi.mock('./mailbox/sqlite/paths.js', () => ({ outboundDbPath: () => ':memory:' }));
vi.mock('./mailbox/sqlite/session-db.js', () => ({
  openOutboundDbRw: () => new Proxy(state.db, { get: (t, k) => (k === 'close' ? () => {} : Reflect.get(t, k)) }),
}));
vi.mock('./modules/scheduling/recurrence.js', () => ({ handleRecurrence: vi.fn() }));
vi.mock('./modules/cross-session-context/index.js', () => ({ pruneEchoBacklog: () => 0 }));

import { isContainerStopping, killContainer } from './container-runner.js';
import { incarnationKey, reconcileSession } from './reconcile-session.js';

function fakeMailbox() {
  return {
    applyProcessingAcks: () => {},
    getTerminalProcessingAcks: () => [],
    countDueMessages: () => 0,
    getProcessingClaims: () => [...state.claims],
    getContainerState: () => null,
    getMessageForRetry: () => null,
    deleteOrphanProcessingClaims: () => {
      const n = state.claims.length;
      state.claims = [];
      return n;
    },
    countLiveTasks: () => 0,
  };
}

const hasContinuation = () =>
  state.db.prepare("SELECT 1 FROM session_state WHERE key = 'continuation:claude'").get() !== undefined;

/** One reconcile of a fresh incarnation that has been silent past the ceiling. */
async function ceilingPass(incarnation: number, withStuckTurn: boolean): Promise<void> {
  // The same incarnation keeps its start time: a repeat pass sees the same container.
  if (state.incarnation !== incarnation || !state.startedAtMs)
    state.startedAtMs = Date.now() - 2 * 60 * 60 * 1000 - incarnation;
  state.incarnation = incarnation;
  state.claims = withStuckTurn ? [{ messageId: `m-${incarnation}`, statusChanged: new Date().toISOString() }] : [];
  await reconcileSession('sess-1');
}

beforeEach(() => {
  state.incarnation = 0;
  state.startedAtMs = 0;
  state.noIds = false;
  state.heartbeat = '/nonexistent/heartbeat';
  vi.mocked(killContainer).mockClear();
  vi.mocked(isContainerStopping).mockReturnValue(false);
  state.db = new Database(':memory:');
  state.db.exec(`
    CREATE TABLE messages_out (seq INTEGER);
    CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO messages_out (seq) VALUES (41);
  `);
  state.db
    .prepare("INSERT INTO session_state VALUES ('continuation:claude', 'sess-abc', ?)")
    .run(new Date().toISOString());
});

describe('reconcile — absolute ceiling', () => {
  it('reaps idle containers without ever clearing the conversation', async () => {
    await ceilingPass(1, false);
    await ceilingPass(2, false);
    await ceilingPass(3, false);
    expect(killContainer).toHaveBeenCalledTimes(3);
    expect(killContainer).toHaveBeenCalledWith('sess-1', 'absolute-ceiling');
    expect(hasContinuation()).toBe(true);
  });

  it('still clears a continuation after two stuck turns with no output', async () => {
    await ceilingPass(1, true);
    expect(hasContinuation()).toBe(true);
    await ceilingPass(2, true);
    expect(hasContinuation()).toBe(false);
  });

  it('counts a repeated kill of the same incarnation once', async () => {
    // The kill has not landed yet (no stop recorded): the next reconcile sees the same container.
    await ceilingPass(1, true);
    await ceilingPass(1, true);
    expect(killContainer).toHaveBeenCalledTimes(2);
    expect(hasContinuation()).toBe(true);
    await ceilingPass(2, true); // a new incarnation, still no output
    expect(hasContinuation()).toBe(false);
  });

  it('counts every kill when neither id is known, so the self-heal still fires', async () => {
    expect(incarnationKey(undefined, undefined)).toBe('');
    expect(incarnationKey(null, null)).toBe('');
    expect(incarnationKey(3, undefined)).toBe('3:');
    expect(incarnationKey(undefined, 1700)).toBe(':1700');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceiling-'));
    try {
      state.heartbeat = path.join(dir, 'heartbeat');
      fs.writeFileSync(state.heartbeat, '');
      const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(state.heartbeat, old, old);
      state.noIds = true;
      await ceilingPass(1, true);
      expect(killContainer).toHaveBeenCalledTimes(1);
      expect(hasContinuation()).toBe(true);
      await ceilingPass(1, true);
      expect(hasContinuation()).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a container that is already stopping to that stop', async () => {
    vi.mocked(isContainerStopping).mockReturnValue(true);
    await ceilingPass(1, true);
    await ceilingPass(1, true);
    expect(killContainer).not.toHaveBeenCalled();
    expect(hasContinuation()).toBe(true);
  });
});
