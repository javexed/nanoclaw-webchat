/**
 * A slot missed while the host was down fires once — no catch-up burst, no
 * silent skip. This is core's scheduler behavior, pinned here because the
 * failure policy relies on it (see policy.ts): the missed occurrence is one
 * pending row that is due on return, and re-arming computes the next slot
 * from the cron grid relative to now, not from the missed slot.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-config.js', () => ({ resolveGroupTimezone: async () => 'UTC' }));

import { ensureSchema, openInboundDb } from '../../mailbox/sqlite/session-db.js';
import { wrapSqliteInbound } from '../../mailbox/sqlite/index.js';
import { insertTaskRow } from '../../mailbox/sqlite/tasks.js';
import type { Session } from '../../types.js';
import { handleRecurrence } from '../scheduling/recurrence.js';

let dir: string;
const session = { id: 'sess', agent_group_id: 'ag', thread_id: null } as Session;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missed-slot-'));
  ensureSchema(path.join(dir, 'inbound.db'), 'inbound');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('a missed slot after downtime', () => {
  it('is one due occurrence, and re-arms once to the next future slot', async () => {
    const db = openInboundDb(path.join(dir, 'inbound.db'));
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    threeDaysAgo.setUTCHours(9, 0, 0, 0);
    insertTaskRow(db, {
      id: 'daily-1a2b',
      seriesId: 'daily-1a2b',
      processAfter: threeDaysAgo.toISOString(),
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'brief me' }),
    });
    const inbox = wrapSqliteInbound(db);

    // Back up after three missed days: exactly one occurrence is due.
    expect(inbox.countDueMessages()).toBe(1);

    // It runs once; the series re-arms exactly once, into the future.
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'daily-1a2b'").run();
    await handleRecurrence(inbox, session);
    await handleRecurrence(inbox, session); // a second pass must not arm again

    const pending = db
      .prepare("SELECT process_after FROM messages_in WHERE kind = 'task' AND status = 'pending'")
      .all() as Array<{ process_after: string }>;
    expect(pending).toHaveLength(1);
    const next = Date.parse(pending[0]!.process_after);
    expect(next).toBeGreaterThan(Date.now());
    expect(next - Date.now()).toBeLessThanOrEqual(86_400_000);
    expect(inbox.countDueMessages()).toBe(0);
    db.close();
  });
});
