/**
 * The task-run policy against real session DBs (core's schemas) and the real
 * central tables: which runs are retried, which fail without a retry, how
 * finished runs are classified, and when the owner hears about it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../session-db-access.js', async () => {
  const raw = await import('../../mailbox/sqlite/session-db.js');
  const inP = () => path.join(paths.dir, 'inbound.db');
  const outP = () => path.join(paths.dir, 'outbound.db');
  return {
    inboundDbPath: inP,
    outboundDbPath: outP,
    openInboundDb: () => raw.openInboundDb(inP()),
    openOutboundDb: () => raw.openOutboundDb(outP()),
  };
});
vi.mock('../../container-runner.js', () => ({ isContainerRunning: () => false }));
vi.mock('./notify.js', () => ({ sendAlert: vi.fn(async () => true) }));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { taskThreadId } from '../../db/sessions.js';
import { ensureSchema } from '../../mailbox/sqlite/session-db.js';
import { insertTaskRow } from '../../mailbox/sqlite/tasks.js';
import type { Session } from '../../types.js';
import type { Alert } from './incidents.js';
import { applyTaskRunPolicy, REASON, type PolicyDeps } from './policy.js';
import { getIncident, getRun, upsertRun } from './store.js';

const SERIES = 'daily-brief-1a2b';
const MIN = 60_000;

let now: number;
let running: boolean;
let alerts: Alert[];
let logs: string[];
let inbound: Database.Database;

const session: Session = {
  id: 'sess-task',
  agent_group_id: 'ag-1',
  messaging_group_id: null,
  thread_id: taskThreadId(SERIES),
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: new Date().toISOString(),
};

const deps: PolicyDeps = {
  now: () => now,
  isRunning: () => running,
  appendLog: async (_g, _s, line) => {
    logs.push(line);
  },
  notify: async (alert) => {
    alerts.push(alert);
    return true;
  },
};

const pass = () => applyTaskRunPolicy(session, deps);

function outbound(): Database.Database {
  return new Database(path.join(paths.dir, 'outbound.db'));
}

/** A new-enough agent-runner creates task_run_marks on its first batch. */
function runnerWritesMarks(): void {
  const db = outbound();
  db.exec(`CREATE TABLE IF NOT EXISTS task_run_marks (
    message_id TEXT PRIMARY KEY, reached_at TEXT, outcome TEXT, reason TEXT, updated_at TEXT NOT NULL)`);
  db.close();
}

function mark(id: string, fields: { reached?: boolean; outcome?: string; reason?: string }): void {
  runnerWritesMarks();
  const db = outbound();
  db.prepare(
    'INSERT OR REPLACE INTO task_run_marks (message_id, reached_at, outcome, reason, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, fields.reached ? new Date(now).toISOString() : null, fields.outcome ?? null, fields.reason ?? null, 'x');
  db.close();
}

function ack(id: string, status: string): void {
  const db = outbound();
  db.prepare('INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)').run(
    id,
    status,
    new Date(now).toISOString(),
  );
  db.close();
}

function addRun(id: string, dueAt = now - MIN, extra: { recurrence?: string } = {}): void {
  insertTaskRow(inbound, {
    id,
    seriesId: SERIES,
    processAfter: new Date(dueAt).toISOString(),
    recurrence: extra.recurrence ?? null,
    content: JSON.stringify({ prompt: 'brief me', script: null, originSessionId: 'sess-room' }),
  });
}

function row(id: string): { status: string; process_after: string; tries: number } {
  return inbound.prepare('SELECT status, process_after, tries FROM messages_in WHERE id = ?').get(id) as never;
}

/** What core does to a finished row on the same pass: apply the container's ack. */
function finish(id: string, status: 'completed' | 'failed'): void {
  inbound.prepare('UPDATE messages_in SET status = ? WHERE id = ?').run(status, id);
}

beforeEach(async () => {
  paths.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-health-'));
  ensureSchema(path.join(paths.dir, 'inbound.db'), 'inbound');
  ensureSchema(path.join(paths.dir, 'outbound.db'), 'outbound');
  inbound = new Database(path.join(paths.dir, 'inbound.db'));
  await initTestDb();
  await runMigrations(getDb());
  now = Date.parse('2026-10-01T09:00:00.000Z');
  running = false;
  alerts = [];
  logs = [];
});

afterEach(async () => {
  inbound.close();
  await closeDb();
  fs.rmSync(paths.dir, { recursive: true, force: true });
});

describe('runs that never reached the model are retried at +5, +15, +30 min, then given up', () => {
  it('a container that cannot start: grace first, then the schedule, then one alert', async () => {
    runnerWritesMarks();
    addRun('r1');

    await pass(); // first sight of a due, unclaimed row: start the grace clock
    now += 2 * MIN;
    await pass();
    expect(row('r1').tries).toBe(0);

    const delays = [5, 15, 30];
    for (const [i, delay] of delays.entries()) {
      now += 3 * MIN; // grace elapsed with no container
      await pass();
      expect(row('r1').status).toBe('pending');
      expect(row('r1').tries).toBe(i + 1);
      expect(Date.parse(row('r1').process_after)).toBe(now + delay * MIN);
      expect(logs.at(-1)).toContain(`retry ${i + 1} of 3 in ${delay} min`);
      now += delay * MIN; // due again
      await pass(); // grace clock restarts
    }

    now += 3 * MIN;
    await pass();
    expect(row('r1').status).toBe('failed');
    expect(await getRun('r1')).toMatchObject({ outcome: 'failed', signature: 'not-started' });
    expect(alerts).toEqual([expect.objectContaining({ kind: 'opened', signature: 'not-started' })]);
  });

  it('a container that died holding the row before its first query is retried without the grace', async () => {
    runnerWritesMarks();
    addRun('r1');
    ack('r1', 'processing');
    await pass();
    expect(row('r1')).toMatchObject({ status: 'pending', tries: 1 });
    expect(Date.parse(row('r1').process_after)).toBe(now + 5 * MIN);
    expect((await getRun('r1'))!.last_error).toBe(REASON.diedBeforeQuery);
    expect(alerts).toEqual([]);

    // The orphan claim is still there on the next pass (core clears it later):
    // the scheduled retry is not counted twice.
    now += MIN;
    await pass();
    expect(row('r1').tries).toBe(1);
  });

  it("core's own stuck reset (tries bumped, short backoff) is overridden by the schedule", async () => {
    runnerWritesMarks();
    addRun('r1');
    inbound
      .prepare('UPDATE messages_in SET tries = 1, process_after = ? WHERE id = ?')
      .run(new Date(now + 5_000).toISOString(), 'r1');
    await pass();
    expect(row('r1').tries).toBe(2);
    expect(Date.parse(row('r1').process_after)).toBe(now + 5 * MIN);
  });

  it('a host that was down does not count its downtime as a failing start (the missed slot just fires)', async () => {
    runnerWritesMarks();
    addRun('r1');
    await pass();
    now += 6 * 60 * MIN; // host down for six hours
    await pass(); // observation gap: the grace clock restarts
    expect(row('r1').tries).toBe(0);
    running = true; // the wake worked
    now += MIN;
    await pass();
    expect((await getRun('r1'))!.waiting_since).toBeNull();
  });
});

describe('runs that reached the model are never retried', () => {
  it('a container that died mid-run fails the run instead of re-running it', async () => {
    addRun('r1');
    ack('r1', 'processing');
    mark('r1', { reached: true });
    await pass();
    expect(row('r1').status).toBe('failed');
    expect(row('r1').tries).toBe(0);
    expect(await getRun('r1')).toMatchObject({ outcome: 'failed', signature: 'interrupted' });
    expect(alerts.map((a) => a.kind)).toEqual(['opened']);
  });

  it("…including after core's ceiling reset already cleared the claim", async () => {
    addRun('r1');
    mark('r1', { reached: true });
    inbound
      .prepare('UPDATE messages_in SET tries = 1, process_after = ? WHERE id = ?')
      .run(new Date(now + 5_000).toISOString(), 'r1');
    await pass();
    expect(row('r1').status).toBe('failed');
  });

  it('a run still in progress is left alone', async () => {
    addRun('r1');
    ack('r1', 'processing');
    mark('r1', { reached: true });
    running = true;
    await pass();
    expect(row('r1')).toMatchObject({ status: 'pending', tries: 0 });
  });

  it('a model error is a failed run, not a retry', async () => {
    addRun('r1');
    mark('r1', { reached: true, outcome: 'error', reason: 'model qwen9 not found' });
    ack('r1', 'completed');
    await pass();
    expect(row('r1')).toMatchObject({ status: 'pending', tries: 0 }); // no retry scheduled
    finish('r1', 'completed');
    await pass();
    expect(await getRun('r1')).toMatchObject({
      outcome: 'failed',
      signature: 'model-error',
      reason: 'model qwen9 not found',
    });
    expect(row('r1').status).toBe('completed');
  });
});

describe('finished runs are classified the pass their ack lands', () => {
  it("a one-shot's last run is judged before core applies the ack (its session closes that same pass)", async () => {
    addRun('r1');
    await pass();
    mark('r1', { reached: true, outcome: 'error', reason: 'boom' });
    ack('r1', 'completed');
    await pass();
    expect(row('r1').status).toBe('pending'); // core applies the ack after the policy
    expect(await getRun('r1')).toMatchObject({ outcome: 'failed', signature: 'model-error' });
    expect(alerts.map((a) => a.kind)).toEqual(['opened']);
    finish('r1', 'completed');
    await pass();
    expect(alerts).toHaveLength(1); // judged once
  });
});

describe('an agent-runner without task_run_marks keeps core behavior', () => {
  it('leaves a dead claim to core and counts a completed run ok', async () => {
    addRun('r1');
    ack('r1', 'processing');
    await pass();
    expect(row('r1')).toMatchObject({ status: 'pending', tries: 0 });
    finish('r1', 'completed');
    await pass();
    expect(await getRun('r1')).toMatchObject({ outcome: 'ok' });
  });
});

describe('one alert per incident', () => {
  async function runOnce(id: string, how: 'ok' | 'error' | 'gated' | 'declared', reason = 'upstream API 503') {
    addRun(id);
    await pass(); // the policy sees every run while it is pending
    if (how !== 'gated') mark(id, { reached: true, outcome: how === 'error' ? 'error' : 'ok', reason });
    else runnerWritesMarks();
    if (how === 'declared') {
      await upsertRun(
        { row_id: id, series_id: SERIES, agent_group_id: 'ag-1', session_id: session.id },
        {
          declared_reason: reason,
        },
      );
    }
    finish(id, 'completed');
    await pass();
  }

  it('alerts on the first failure, stays quiet, reminds after the interval, announces recovery', async () => {
    await runOnce('r1', 'error');
    expect(alerts.map((a) => a.kind)).toEqual(['opened']);
    expect(logs.at(-1)).toBe('failure alert sent to the task owner');

    now += 60 * MIN;
    await runOnce('r2', 'error');
    now += 60 * MIN;
    await runOnce('r3', 'error');
    expect(alerts).toHaveLength(1);
    expect((await getIncident(SERIES))!.failures).toBe(3);

    now += 24 * 60 * MIN;
    await runOnce('r4', 'error');
    expect(alerts.map((a) => a.kind)).toEqual(['opened', 'reminder']);
    expect(alerts[1]!.failures).toBe(4);

    now += 60 * MIN;
    await runOnce('r5', 'ok');
    expect(alerts.map((a) => a.kind)).toEqual(['opened', 'reminder', 'recovered']);
    expect((await getIncident(SERIES))!.state).toBe('closed');

    now += 60 * MIN;
    await runOnce('r6', 'ok');
    expect(alerts).toHaveLength(3);
  });

  it('a different failure signature is a new incident', async () => {
    await runOnce('r1', 'error');
    await runOnce('r2', 'declared', 'the report had no rows');
    expect(alerts.map((a) => [a.kind, a.signature])).toEqual([
      ['opened', 'model-error'],
      ['opened', 'agent-declared'],
    ]);
    expect(alerts[1]!.reason).toBe('the report had no rows');
  });

  it('a script-gated run (never reached the model) neither opens nor closes an incident', async () => {
    await runOnce('r1', 'gated');
    expect(await getRun('r1')).toMatchObject({ outcome: 'skipped' });
    expect(alerts).toEqual([]);
    await runOnce('r2', 'error');
    await runOnce('r3', 'gated');
    expect(alerts.map((a) => a.kind)).toEqual(['opened']);
    expect((await getIncident(SERIES))!.state).toBe('open');
  });

  it('a broken pre-task script is a failure with its own signature', async () => {
    addRun('r1');
    await pass();
    runnerWritesMarks();
    ack('r1', 'script-skip:error');
    finish('r1', 'failed');
    await pass();
    expect(await getRun('r1')).toMatchObject({ outcome: 'failed', signature: 'script' });
    expect(alerts.map((a) => a.signature)).toEqual(['script']);
  });
});
