/**
 * `ncl tasks fail` and the `health` block on `ncl tasks get`, layered onto the
 * real `tasks` resource.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '', sessions: new Map<string, unknown>(), log: [] as string[] }));

vi.mock('../../session-db-access.js', async () => {
  const raw = await import('../../mailbox/sqlite/session-db.js');
  const inP = () => path.join(state.dir, 'inbound.db');
  const outP = () => path.join(state.dir, 'outbound.db');
  return {
    inboundDbPath: inP,
    outboundDbPath: outP,
    openInboundDb: () => raw.openInboundDb(inP()),
    openOutboundDb: () => raw.openOutboundDb(outP()),
  };
});
vi.mock('../../container-runner.js', () => ({ isContainerRunning: () => false }));
vi.mock('../../db/sessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/sessions.js')>();
  return { ...actual, getSession: async (id: string) => state.sessions.get(id) };
});
vi.mock('../scheduling/run-log.js', () => ({
  appendRunLog: async (_g: string, _s: string, msg: string) => {
    state.log.push(msg);
    return {};
  },
  readRunLogTail: async () => [],
  deleteRunLog: async () => {},
}));

import { getResource } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { renderVerbHelp } from '../../cli/help-render.js';
import { lookup } from '../../cli/registry.js';
import '../../cli/resources/tasks.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { taskThreadId } from '../../db/sessions.js';
import { ensureSchema } from '../../mailbox/sqlite/session-db.js';
import { insertTaskRow } from '../../mailbox/sqlite/tasks.js';
import { installTaskHealthCli } from './cli.js';
import { recordVerdict } from './incidents.js';
import { getIncident, getRun, pruneFinishedRuns, upsertRun } from './store.js';

const SERIES = 'daily-brief-1a2b';
const taskStatus = { value: 'pending' };
const agent = (sessionId: string): CallerContext => ({
  caller: 'agent',
  sessionId,
  agentGroupId: 'ag-1',
  messagingGroupId: 'mg-1',
});

beforeAll(() => {
  // Stand in for core's get/delete so the wrappers can be observed without a mailbox.
  const ops = getResource('tasks')!.customOperations!;
  ops.get!.handler = async (args) => ({ series_id: args.id, status: taskStatus.value });
  ops.cancel!.handler = async (args) => ({ series_id: args.id, touched: 1 });
  ops.delete!.handler = async (args) => ({ series_id: args.id, touched: 1 });
  installTaskHealthCli();
  installTaskHealthCli(); // idempotent: a second host start must not double-register
});

beforeEach(async () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-health-cli-'));
  ensureSchema(path.join(state.dir, 'inbound.db'), 'inbound');
  ensureSchema(path.join(state.dir, 'outbound.db'), 'outbound');
  state.sessions = new Map([
    ['sess-task', { id: 'sess-task', agent_group_id: 'ag-1', thread_id: taskThreadId(SERIES) }],
    ['sess-room', { id: 'sess-room', agent_group_id: 'ag-1', thread_id: null }],
  ]);
  state.log = [];
  taskStatus.value = 'pending';
  await initTestDb();
  await runMigrations(getDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

function startRun(id: string): void {
  const inbound = new Database(path.join(state.dir, 'inbound.db'));
  insertTaskRow(inbound, {
    id,
    seriesId: SERIES,
    processAfter: new Date().toISOString(),
    recurrence: '0 9 * * *',
    content: JSON.stringify({ prompt: 'brief me' }),
  });
  inbound.close();
  const outbound = new Database(path.join(state.dir, 'outbound.db'));
  outbound
    .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
    .run(id, 'processing', new Date().toISOString());
  outbound.close();
}

const fail = (args: Record<string, unknown>, ctx: CallerContext) => {
  const cmd = lookup('tasks-fail')!;
  return cmd.handler(cmd.parseArgs(args), ctx);
};

describe('ncl tasks fail', () => {
  it('is a tasks verb with its own help', () => {
    expect(lookup('tasks-fail')).toMatchObject({ resource: 'tasks', access: 'open' });
    expect(renderVerbHelp(getResource('tasks')!, 'fail')).toContain('--reason');
  });

  it('marks the in-flight run failed and logs why', async () => {
    startRun('r1');
    expect(await fail({ reason: 'sales API returned 503\nfor every region' }, agent('sess-task'))).toEqual({
      series_id: SERIES,
      row_id: 'r1',
      failed: true,
    });
    expect((await getRun('r1'))!.declared_reason).toBe('sales API returned 503 for every region');
    expect(state.log).toEqual(['run marked failed by the agent: sales API returned 503 for every region']);
  });

  it('refuses outside a running task', async () => {
    await expect(fail({ reason: 'x' }, { caller: 'host' })).rejects.toThrow(/only a running task/);
    await expect(fail({ reason: 'x' }, agent('sess-room'))).rejects.toThrow(/not inside a task run/);
    await expect(fail({ reason: 'x' }, agent('sess-task'))).rejects.toThrow(/no task run is in progress/);
  });

  it('requires a reason and rejects unknown flags', async () => {
    expect(() => lookup('tasks-fail')!.parseArgs({})).toThrow(/reason/);
    expect(() => lookup('tasks-fail')!.parseArgs({ reason: 'x', bogus: 1 })).toThrow();
  });
});

describe('ncl tasks get', () => {
  it('reports an unknown health for a task that has not finished a run', async () => {
    const out = (await lookup('tasks-get')!.handler({ id: SERIES }, { caller: 'host' })) as Record<string, unknown>;
    expect(out).toMatchObject({ series_id: SERIES, health: { state: 'unknown', incident: null, last_run: null } });
  });

  it('shows an open incident, the last run, and a pending start retry', async () => {
    const key = { series_id: SERIES, agent_group_id: 'ag-1', session_id: 'sess-task' };
    await upsertRun(
      { ...key, row_id: 'r1' },
      { outcome: 'failed', signature: 'model-error', reason: 'boom', finished_at: '2026-10-01T09:00:00.000Z' },
    );
    await upsertRun(
      { ...key, row_id: 'r2' },
      { start_failures: 1, next_retry_at: '2026-10-02T09:05:00.000Z', last_error: 'could not start' },
    );
    await recordVerdict(SERIES, 'ag-1', { outcome: 'failed', signature: 'model-error', reason: 'boom' }, new Date());
    const out = (await lookup('tasks-get')!.handler({ id: SERIES }, { caller: 'host' })) as {
      health: Record<string, unknown>;
    };
    expect(out.health).toMatchObject({
      state: 'failing',
      incident: { state: 'open', signature: 'model-error', failures: 1 },
      last_run: { row_id: 'r1', outcome: 'failed', signature: 'model-error' },
      start_retry: { row_id: 'r2', attempt: 1, of: 3, next_at: '2026-10-02T09:05:00.000Z' },
    });
  });

  it('closes the incident of a task that will not run again', async () => {
    const key = { series_id: SERIES, agent_group_id: 'ag-1', session_id: 'sess-task' };
    await upsertRun(
      { ...key, row_id: 'r1' },
      { outcome: 'failed', signature: 'model-error', reason: 'boom', finished_at: '2026-10-01T09:00:00.000Z' },
    );
    await recordVerdict(SERIES, 'ag-1', { outcome: 'failed', signature: 'model-error', reason: 'boom' }, new Date());
    taskStatus.value = 'failed';
    const out = (await lookup('tasks-get')!.handler({ id: SERIES }, { caller: 'host' })) as {
      health: Record<string, unknown>;
    };
    expect(out.health).toMatchObject({ state: 'failed', incident: { state: 'closed' } });
  });

  it('cancel closes the open incident', async () => {
    await recordVerdict(SERIES, 'ag-1', { outcome: 'failed', signature: 'script', reason: null }, new Date());
    await lookup('tasks-cancel')!.handler({ id: SERIES }, { caller: 'host' });
    expect(await getIncident(SERIES)).toMatchObject({ state: 'closed' });
  });

  it('delete forgets the series', async () => {
    await recordVerdict(SERIES, 'ag-1', { outcome: 'failed', signature: 'script', reason: null }, new Date());
    await lookup('tasks-delete')!.handler({ id: SERIES }, { caller: 'host' });
    const out = (await lookup('tasks-get')!.handler({ id: SERIES }, { caller: 'host' })) as {
      health: { incident: unknown };
    };
    expect(out.health.incident).toBeNull();
  });
});

describe('run record pruning', () => {
  it('drops old runs, finished or not, and keeps recent ones', async () => {
    const key = { series_id: SERIES, agent_group_id: 'ag-1', session_id: 'sess-task' };
    await upsertRun({ ...key, row_id: 'old-done' }, { outcome: 'ok', finished_at: '2026-01-01T00:00:00.000Z' });
    await upsertRun({ ...key, row_id: 'old-open' }, { start_failures: 1 });
    await getDb().run(`UPDATE task_runs SET updated_at = '2026-01-01T00:00:00.000Z' WHERE row_id = 'old-open'`);
    await upsertRun({ ...key, row_id: 'new-open' }, { start_failures: 1 });
    await pruneFinishedRuns('2026-06-01T00:00:00.000Z');
    expect(await getRun('old-done')).toBeUndefined();
    expect(await getRun('old-open')).toBeUndefined();
    expect(await getRun('new-open')).toBeDefined();
  });
});
