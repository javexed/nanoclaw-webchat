/**
 * Turn traces end to end on a real database: status events and delivered
 * replies in, one stored trace per turn out — linked to the turn's first
 * reply, redacted, flagged in history, pruned by retention and deleted with
 * its room or thread.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { registerUnforwardedStartCheck } from '../../modules/agent-status/observers.js';
import type { Session } from '../../types.js';

import {
  createWebchatRoom,
  createWebchatThread,
  deleteWebchatRoom,
  deleteWebchatThread,
  setTurnTraceDays,
  setTurnTracesEnabled,
  storeWebchatMessage,
} from './db.js';
import {
  failureNoticeText,
  getTraceForMessage,
  LATE_LINK_MS,
  pruneTurnTraces,
  recordStatusEvent,
  recordTurnMessage,
  resetActiveTraces,
  withTraceFlags,
} from './turn-traces.js';

const NOW = new Date().toISOString();
const SECRET = `sk-ant-api03-${'A'.repeat(95)}`;
let session: Session;

async function ev(kind: string, text: string | null = null, detail: string | null = null): Promise<void> {
  await recordStatusEvent(session, { kind: kind as never, text, detail, createdAt: new Date().toISOString() });
}

/** Store a reply the way deliver() does, without telling the recorder. */
async function store(text: string, thread = 'main'): Promise<string> {
  return (await storeWebchatMessage('gardens', 'AG', 'agent', text, thread)).id;
}

/** Store a reply and hand it to the recorder, as deliver() does. */
async function reply(text: string, thread = 'main'): Promise<string> {
  const id = await store(text, thread);
  await recordTurnMessage('sess-1', id, null);
  return id;
}

async function traceRows(): Promise<{ message_id: string; message_ids: string; outcome: string; thread_id: string }[]> {
  return (await getDb().all(`SELECT message_id, message_ids, outcome, thread_id FROM webchat_turn_traces`)) as never;
}

beforeEach(async () => {
  resetActiveTraces();
  await initTestDb();
  await runMigrations(getDb());
  await createAgentGroup({ id: 'ag-1', name: 'AG', folder: 'ag', agent_provider: null, created_at: NOW });
  const room = await createWebchatRoom('Gardens', 'gardens');
  const mg = (await getDb().get(`SELECT id FROM messaging_groups WHERE platform_id = ?`, room.id)) as { id: string };
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: mg.id,
    thread_id: null,
    agent_provider: 'pi',
    status: 'active',
    container_status: 'running',
    last_active: NOW,
    created_at: NOW,
  };
});
afterEach(async () => {
  registerUnforwardedStartCheck(() => false);
  await closeDb();
});

describe('capture', () => {
  it('stores the turn, redacted, on the first reply once it is done', async () => {
    await ev('start');
    await ev('tool', 'Bash', `curl -H "x-api-key: ${SECRET}" https://api.example.com`);
    await ev('reasoning', 'line', `I will use ${SECRET} to call it`);
    const first = await reply('Here it is');
    const second = await reply('And a follow-up');
    expect(await traceRows()).toHaveLength(0); // still open: nothing stored mid-turn
    await ev('done');

    const rows = await traceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message_id).toBe(first);
    expect(JSON.parse(rows[0]!.message_ids)).toEqual([first, second]);
    const stored = await getTraceForMessage('gardens', first);
    expect(stored!.trace).toMatchObject({ harness: 'pi', agent: 'AG', outcome: 'done' });
    expect(stored!.trace.tools[0]!.name).toBe('Bash');
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('ANTHROPIC_KEY');
    // Every message of the turn resolves to it, not only the anchor.
    expect((await getTraceForMessage('gardens', second))!.message_id).toBe(first);
  });

  it("never stores a per-member session's turn: it may hold what that member's own secrets fetched", async () => {
    session = { ...session, thread_id: 'webchat:alice@example.com::main' };
    await ev('start');
    await ev('tool', 'Bash', 'curl https://dev.azure.com/org/_apis/projects');
    await reply('Here are your projects');
    await ev('done');
    expect(await traceRows()).toHaveLength(0);
  });

  it("links a reply delivered after the turn's done (the runner emits done first)", async () => {
    await ev('start');
    await ev('reasoning', 'thinking', null);
    await ev('done');
    expect(await traceRows()).toHaveLength(0);
    const id = await reply('late reply');
    expect((await traceRows()).map((r) => r.message_id)).toEqual([id]);
  });

  it('does not link a reply from the next turn, nor one after the late window', async () => {
    await ev('start');
    await ev('done');
    await ev('start'); // next turn begins: the previous one lost its chance
    const id = await reply('belongs to turn two');
    await ev('done');
    const rows = await traceRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.message_ids)).toEqual([id]);

    resetActiveTraces();
    await ev('start');
    await ev('done');
    const realNow = Date.now;
    Date.now = () => realNow() + LATE_LINK_MS + 1;
    try {
      await reply('much later');
    } finally {
      Date.now = realNow;
    }
    expect(await traceRows()).toHaveLength(1);
  });

  it('an error turn is stored on its failure notice', async () => {
    await ev('start');
    await ev('tool', 'Read', 'a.ts');
    const notice = await store('Something went wrong: model not found');
    await recordTurnMessage(
      'sess-1',
      notice,
      failureNoticeText({ text: 'Something went wrong: model not found', failureNotice: true }),
    );
    await ev('done');
    const stored = await getTraceForMessage('gardens', notice);
    expect(stored!.trace.outcome).toBe('error');
    expect(stored!.trace.notes).toContainEqual(expect.objectContaining({ kind: 'error' }));
  });

  it('only the flagged failure notice counts as one', () => {
    expect(failureNoticeText({ text: 'boom', failureNotice: true })).toBe('boom');
    expect(failureNoticeText({ text: 'an ordinary reply' })).toBeNull();
    expect(failureNoticeText('plain text')).toBeNull();
  });

  it('a stall with no reply has nothing to hang from and is not stored', async () => {
    await ev('start');
    await ev('tool', 'Bash', 'sleep 999');
    await ev('stalled');
    expect(await traceRows()).toHaveLength(0);
  });

  it('records nothing while the owner has recording off', async () => {
    await setTurnTracesEnabled(false);
    await ev('start');
    await ev('tool', 'Read', 'a.ts');
    await reply('hi');
    await ev('done');
    expect(await traceRows()).toHaveLength(0);
  });

  it('files the trace under the session thread', async () => {
    await createWebchatThread('gardens', 'Side');
    const thread = (
      (await getDb().get(`SELECT thread_id FROM webchat_threads WHERE room_id = 'gardens'`)) as {
        thread_id: string;
      }
    ).thread_id;
    session = { ...session, thread_id: thread };
    await ev('start');
    await reply('in a thread', thread);
    await ev('done');
    expect((await traceRows())[0]!.thread_id).toBe(thread);
  });
});

describe('replies and turns out of step', () => {
  it("a short turn's reply, delivered before its start is read, is its own — not the closed turn's", async () => {
    await ev('start');
    const one = await reply('turn one');
    await ev('done');
    // Turn two starts, replies and ends inside one delivery tick: the reply is
    // delivered while the feed still has turn two's rows unread.
    let unread = true;
    registerUnforwardedStartCheck(() => unread);
    const two = await reply('turn two');
    unread = false;
    await ev('start');
    await ev('done');
    const rows = await traceRows();
    expect(rows.map((r) => [r.message_id, JSON.parse(r.message_ids)])).toEqual([
      [one, [one]],
      [two, [two]],
    ]);
  });

  it('a reply to another room is not the anchor; the reply in the turn room is', async () => {
    await createWebchatRoom('Elsewhere', 'elsewhere');
    await ev('start');
    const away = (await storeWebchatMessage('elsewhere', 'AG', 'agent', 'posted elsewhere', 'main')).id;
    await recordTurnMessage('sess-1', away, null, 'elsewhere');
    const home = await store('here');
    await recordTurnMessage('sess-1', home, null, 'gardens');
    await ev('done');
    const rows = await traceRows();
    expect(rows.map((r) => [r.message_id, JSON.parse(r.message_ids)])).toEqual([[home, [home]]]);
    expect((await getTraceForMessage('gardens', home))!.message_id).toBe(home);
  });

  it('overlapping writes keep one row with every reply', async () => {
    await ev('start');
    await ev('done');
    const a = await store('a');
    const b = await store('b');
    await Promise.all([recordTurnMessage('sess-1', a, null), recordTurnMessage('sess-1', b, null)]);
    const rows = await traceRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.message_ids)).toEqual([a, b]);
  });
});

describe('history flag', () => {
  it('marks only the anchor reply with has_trace', async () => {
    await ev('start');
    const a = await reply('one');
    const b = await reply('two');
    await ev('done');
    const flagged = await withTraceFlags([{ id: a }, { id: b }, { id: 'other' }]);
    expect(flagged).toEqual([{ id: a, has_trace: true }, { id: b }, { id: 'other' }]);
  });

  it('never flags an anchor outside the trace room (its trace would not load there)', async () => {
    await createWebchatRoom('Elsewhere', 'elsewhere');
    const away = (await storeWebchatMessage('elsewhere', 'AG', 'agent', 'posted elsewhere', 'main')).id;
    // As a trace stored before replies were matched to the turn's room left it.
    await getDb().run(
      `INSERT INTO webchat_turn_traces (id, room_id, thread_id, message_id, message_ids, started_at, outcome, trace_json, size)
       VALUES ('t-old', 'gardens', 'main', ?, ?, 0, 'done', '{}', 2)`,
      away,
      JSON.stringify([away]),
    );
    expect(await withTraceFlags([{ id: away }])).toEqual([{ id: away }]);
    expect(await getTraceForMessage('elsewhere', away)).toBeNull();
  });
});

describe('retention and deletion', () => {
  async function storeOne(startedAt?: number): Promise<string> {
    resetActiveTraces();
    await recordStatusEvent(session, {
      kind: 'start',
      text: null,
      detail: null,
      createdAt: new Date(startedAt ?? Date.now()).toISOString(),
    });
    const id = await reply('r');
    await ev('done');
    return id;
  }

  it('prunes traces older than the retention window; 0 keeps them forever', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    await storeOne(Date.now() - 100 * DAY);
    const fresh = await storeOne();
    expect(await pruneTurnTraces()).toBe(1); // default 90 days
    expect((await traceRows()).map((r) => r.message_id)).toEqual([fresh]);

    await storeOne(Date.now() - 400 * DAY);
    await setTurnTraceDays(0);
    expect(await pruneTurnTraces()).toBe(0);
    expect(await traceRows()).toHaveLength(2);
  });

  it('goes with its room', async () => {
    await storeOne();
    await deleteWebchatRoom('gardens');
    expect(await traceRows()).toHaveLength(0);
  });

  it('goes with its thread, and only that thread', async () => {
    await createWebchatThread('gardens', 'Side');
    const thread = (
      (await getDb().get(`SELECT thread_id FROM webchat_threads WHERE room_id = 'gardens'`)) as {
        thread_id: string;
      }
    ).thread_id;
    await storeOne();
    session = { ...session, thread_id: thread };
    await storeOne();
    await deleteWebchatThread('gardens', thread);
    expect((await traceRows()).map((r) => r.thread_id)).toEqual(['main']);
  });
});
