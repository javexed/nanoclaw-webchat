/**
 * Task-run marks: the host's only evidence of whether a task run reached the
 * model, and how its turn ended. Driven through the seam notifiers, the same
 * way the poll loop drives them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { notifyProviderExchange, notifyProviderMessage } from './providers/hooks.js';
import { runTurnRetryHandlers } from './runner-hooks.js';
import { resolvePromptSections } from './seam/prompt-sections.js';
import './task-run-marks.js';

function seedThread(threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(null, null, threadId);
}

function claim(id: string, status = 'processing'): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
    .run(id, status, new Date().toISOString());
}

function marks(): Array<{
  message_id: string;
  reached_at: string | null;
  outcome: string | null;
  reason: string | null;
}> {
  try {
    return getOutboundDb()
      .prepare('SELECT message_id, reached_at, outcome, reason FROM task_run_marks ORDER BY message_id')
      .all() as never;
  } catch {
    return [];
  }
}

const retryCtx = (message: string) =>
  ({ failure: { message }, prompt: 'p', routing: {}, config: {}, retryWith: async () => null }) as never;

beforeEach(() => {
  initTestSessionDb();
});
afterEach(() => closeSessionDb());

describe('task-run marks', () => {
  it('marks every in-flight row reached when a query starts in a task session', () => {
    seedThread('system:tasks:daily-brief-1a2b');
    claim('row-1');
    claim('row-0', 'completed');
    notifyProviderMessage({ kind: 'turn_start' });
    const rows = marks();
    expect(rows.map((r) => r.message_id)).toEqual(['row-1']);
    expect(rows[0]!.reached_at).not.toBeNull();
    expect(rows[0]!.outcome).toBeNull();
  });

  it('records nothing outside a task session', () => {
    seedThread('room-thread');
    claim('chat-1');
    notifyProviderMessage({ kind: 'turn_start' });
    notifyProviderExchange({ prompt: 'p', result: 'boom', status: 'error' });
    expect(marks()).toEqual([]);
    expect(resolvePromptSections([], {}).some((s) => s.includes('ncl tasks fail'))).toBe(false);
  });

  it('records an error result with its reason', () => {
    seedThread('system:tasks:t-abc123');
    claim('row-1');
    notifyProviderMessage({ kind: 'turn_start' });
    notifyProviderExchange({ prompt: 'p', result: 'model not found:\n  qwen9', status: 'error' });
    expect(marks()[0]).toMatchObject({ outcome: 'error', reason: 'model not found: qwen9' });
  });

  it('records a thrown query through the turn-retry seam, and declines the failure', async () => {
    seedThread('system:tasks:t-abc123');
    claim('row-1');
    notifyProviderMessage({ kind: 'turn_start' });
    expect(await runTurnRetryHandlers(retryCtx('socket hang up'))).toBeNull();
    expect(marks()[0]).toMatchObject({ outcome: 'error', reason: 'socket hang up' });
  });

  it('a later successful result for the same rows wins (a recovered turn ends ok)', async () => {
    seedThread('system:tasks:t-abc123');
    claim('row-1');
    notifyProviderMessage({ kind: 'turn_start' });
    await runTurnRetryHandlers(retryCtx('primary failed'));
    notifyProviderExchange({ prompt: 'p', result: 'done', status: 'completed' });
    expect(marks()[0]).toMatchObject({ outcome: 'ok', reason: null });
  });

  it('keeps the first reach time when a follow-up turn starts', () => {
    seedThread('system:tasks:t-abc123');
    claim('row-1');
    notifyProviderMessage({ kind: 'turn_start' });
    const first = marks()[0]!.reached_at;
    claim('row-2');
    notifyProviderMessage({ kind: 'turn_start', resetFeed: true });
    const rows = marks();
    expect(rows.map((r) => r.message_id)).toEqual(['row-1', 'row-2']);
    expect(rows[0]!.reached_at).toBe(first);
  });

  it('tells task runs how to declare a failed run', () => {
    seedThread('system:tasks:t-abc123');
    expect(resolvePromptSections([], {}).some((s) => s.includes('ncl tasks fail --reason'))).toBe(true);
  });
});
