/**
 * Slice 0 — per-room threads storage layer: the migration (thread tables +
 * thread_id column), thread CRUD, thread-partitioned message read/write, and
 * per-thread read markers. See docs/webchat/threads.md §3,§9.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  MAIN_THREAD,
  createWebchatRoom,
  deleteWebchatRoom,
  storeWebchatMessage,
  getWebchatMessages,
  ensureMainThread,
  ensureAgentThread,
  ensureThread,
  createWebchatThread,
  listWebchatThreads,
  getWebchatThread,
  renameWebchatThread,
  deleteWebchatThread,
  markThreadRead,
  getUnreadThreadIdsForRoom,
  threadToSessionKey,
  sessionKeyToThread,
  sanitizeThreadTitle,
} from './db.js';
import { createSession } from '../../db/sessions.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { findSessionsByMessagingGroupThread } from '../../session-teardown.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  await createWebchatRoom('Room', 'room-1');
});
afterEach(async () => {
  await closeDb();
});

describe('session-key mapping (slice 1)', () => {
  it("maps 'main'/absent to the legacy null session, named threads to themselves", async () => {
    // main/absent → null: a thread-less room keeps its existing session
    expect(threadToSessionKey(MAIN_THREAD)).toBeNull();
    expect(threadToSessionKey(null)).toBeNull();
    expect(threadToSessionKey(undefined)).toBeNull();
    expect(threadToSessionKey('')).toBeNull();
    // named threads key their own session
    expect(threadToSessionKey('agent:sarah')).toBe('agent:sarah');
    expect(threadToSessionKey('u_abc')).toBe('u_abc');
  });
  it('inverse maps a session key back to the stored/UI thread', async () => {
    expect(await sessionKeyToThread(null)).toBe(MAIN_THREAD);
    expect(await sessionKeyToThread(undefined)).toBe(MAIN_THREAD);
    expect(await sessionKeyToThread('agent:sarah')).toBe('agent:sarah');
  });
  // REGRESSION: the per-member credential override re-keys a session by USER, so
  // its thread_id is a user id, not a thread. Passed through, agent replies were
  // stored under a thread_id with no webchat_threads row — a phantom thread the
  // UI cannot list or open. Twelve of one member's replies vanished into one.
  it('sends a session key that names no thread in the room to main', async () => {
    const room = 'room-phantom';
    await createWebchatRoom(room, 'Phantom');
    const real = await createWebchatThread(room, 'Project Management');

    // A real thread still maps to itself...
    expect(await sessionKeyToThread(real.thread_id, room)).toBe(real.thread_id);
    // ...while a per-member session key does not become a thread of its own.
    expect(await sessionKeyToThread('webchat:tailscale:mark@example.com', room)).toBe(MAIN_THREAD);
  });

  // Step 5: a composite key KNOWS its thread, so decode rather than guess. The
  // roomId heuristic could only answer "not a real thread -> main", which put a
  // topic thread's replies in the room.
  it('decodes a per-member composite key to its real thread', async () => {
    const room = 'room-decode';
    await createWebchatRoom(room, 'Decode');
    const real = await createWebchatThread(room, 'Project Management');
    const key = `webchat:tailscale:mark@example.com::${real.thread_id}`;

    expect(await sessionKeyToThread(key, room)).toBe(real.thread_id);
    // ...and without a roomId too — the paths that leaked composite keys into
    // webchat_messages never passed one.
    expect(await sessionKeyToThread(key)).toBe(real.thread_id);
    // main encodes explicitly and must come back as main, not as the raw key.
    expect(await sessionKeyToThread('webchat:tailscale:mark@example.com::main')).toBe(MAIN_THREAD);
  });

  // The composite shape is parsed in db.ts but DEFINED in user-credentials.
  // If they ever disagree, composite keys silently become phantom threads
  // again — so assert the two agree rather than trusting a comment.
  it('agrees with the user-credentials codec on the key shape', async () => {
    const { memberSessionKey } = await import('../../modules/user-credentials/identity.js');
    for (const thread of [null, 'topic-abc', '10a2ab64-8fd3-435d-a94b-a08cb73cfc54']) {
      const key = memberSessionKey('webchat:tailscale:mark@example.com', thread);
      expect(await sessionKeyToThread(key)).toBe(thread ?? MAIN_THREAD);
    }
  });

  it('keeps the old pass-through when no room is supplied', async () => {
    // Callers that never see per-member sessions must be unaffected.
    expect(await sessionKeyToThread('agent:sarah')).toBe('agent:sarah');
  });

  it('round-trips named threads', async () => {
    for (const t of ['agent:max', 'u_xyz']) {
      expect(await sessionKeyToThread(threadToSessionKey(t))).toBe(t);
    }
  });
});

describe('thread title sanitizer (slice 2)', () => {
  it('trims/collapses/bounds; rejects empty, too-long, non-string', async () => {
    expect(sanitizeThreadTitle('  Q3   plan ')).toBe('Q3 plan');
    expect(sanitizeThreadTitle('')).toBeNull();
    expect(sanitizeThreadTitle('   ')).toBeNull();
    expect(sanitizeThreadTitle(42)).toBeNull();
    expect(sanitizeThreadTitle('a'.repeat(80))).toBe('a'.repeat(80));
    expect(sanitizeThreadTitle('a'.repeat(81))).toBeNull();
  });
});

describe('per-thread session teardown lookup (slice 2)', () => {
  const sess = (id: string, threadId: string | null, mgId: string) => ({
    id,
    agent_group_id: 'ag1',
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: 'claude',
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
  it('finds sessions for (room mg, thread); ignores other threads', async () => {
    const mg = (await getMessagingGroupByPlatform('webchat', 'room-1'))!;
    await createAgentGroup({
      id: 'ag1',
      name: 'A',
      folder: 'a',
      agent_provider: 'claude',
      created_at: new Date().toISOString(),
    });
    await createSession(sess('s-q3', 'u_q3', mg.id));
    await createSession(sess('s-main', null, mg.id));
    expect((await findSessionsByMessagingGroupThread(mg.id, 'u_q3')).map((f) => f.sessionId)).toEqual(['s-q3']);
    expect(await findSessionsByMessagingGroupThread(mg.id, 'nope')).toEqual([]);
  });
});

describe('migration', () => {
  it('adds the thread tables + thread_id column (default main)', async () => {
    // tables exist (helper calls don't throw)
    expect(() => listWebchatThreads('room-1')).not.toThrow();
    // a message stored without a thread lands in 'main' via the column default
    const m = await storeWebchatMessage('room-1', 'Alice', 'user', 'hi');
    expect(m.thread_id).toBe('main');
    const col = ((await getDb().all("PRAGMA table_info('webchat_messages')")) as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(col).toContain('thread_id');
  });
});

describe('thread CRUD', () => {
  it('ensureThread is idempotent and does not clobber the title', async () => {
    await ensureMainThread('room-1');
    await ensureThread('room-1', MAIN_THREAD, 'IGNORED', 'main'); // second ensure
    const main = (await getWebchatThread('room-1', MAIN_THREAD))!;
    expect(main.title).toBe('Main');
    expect(main.kind).toBe('main');
  });

  it('ensureAgentThread keys a deterministic per-agent lane', async () => {
    const id = await ensureAgentThread('room-1', 'sarah', 'Sarah');
    expect(id).toBe('agent:sarah');
    expect(await ensureAgentThread('room-1', 'sarah', 'Sarah (again)')).toBe('agent:sarah'); // reused
    expect((await getWebchatThread('room-1', 'agent:sarah'))!.title).toBe('Sarah'); // not clobbered
  });

  it('createWebchatThread makes a uuid topic thread', async () => {
    const t = await createWebchatThread('room-1', 'Q3 planning');
    expect(t.kind).toBe('topic');
    expect(t.thread_id).not.toBe('main');
    expect((await getWebchatThread('room-1', t.thread_id))!.title).toBe('Q3 planning');
  });

  it('lists threads with main first', async () => {
    await createWebchatThread('room-1', 'Topic A');
    await ensureMainThread('room-1');
    await ensureAgentThread('room-1', 'max', 'Max');
    const list = await listWebchatThreads('room-1');
    expect(list[0].thread_id).toBe('main');
    expect(list.map((t) => t.kind)).toContain('agent');
    expect(list.map((t) => t.kind)).toContain('topic');
  });

  it('renames a thread', async () => {
    const t = await createWebchatThread('room-1', 'old');
    await renameWebchatThread('room-1', t.thread_id, 'new');
    expect((await getWebchatThread('room-1', t.thread_id))!.title).toBe('new');
  });
});

describe('thread-partitioned messages', () => {
  it('stores + reads history per thread', async () => {
    await storeWebchatMessage('room-1', 'Alice', 'user', 'in main'); // → main
    const t = await createWebchatThread('room-1', 'Q3');
    await storeWebchatMessage('room-1', 'Alice', 'user', 'in q3', t.thread_id);

    expect((await getWebchatMessages('room-1', 200, MAIN_THREAD)).map((m) => m.content)).toEqual(['in main']);
    expect((await getWebchatMessages('room-1', 200, t.thread_id)).map((m) => m.content)).toEqual(['in q3']);
    // no thread filter → all of the room's messages
    expect((await getWebchatMessages('room-1')).length).toBe(2);
  });
});

describe('per-thread read markers', () => {
  it('flags only threads with activity newer than the marker', async () => {
    const t = await createWebchatThread('room-1', 'Q3');
    await storeWebchatMessage('room-1', 'Alice', 'user', 'a', MAIN_THREAD);
    await storeWebchatMessage('room-1', 'Alice', 'user', 'b', t.thread_id);

    // nothing read yet → both unread
    expect(await getUnreadThreadIdsForRoom('u1', 'room-1')).toEqual(new Set([MAIN_THREAD, t.thread_id]));

    await markThreadRead('u1', 'room-1', MAIN_THREAD, Date.now() + 1000);
    expect(await getUnreadThreadIdsForRoom('u1', 'room-1')).toEqual(new Set([t.thread_id]));
  });

  it('marker is monotonic (never moves backward)', async () => {
    await storeWebchatMessage('room-1', 'Alice', 'user', 'a', MAIN_THREAD);
    await markThreadRead('u1', 'room-1', MAIN_THREAD, 5000);
    await markThreadRead('u1', 'room-1', MAIN_THREAD, 1000); // older — ignored
    const row = (await getDb().get(
      `SELECT last_read_at FROM webchat_thread_reads WHERE user_id=? AND room_id=? AND thread_id=?`,
      'u1',
      'room-1',
      MAIN_THREAD,
    )) as { last_read_at: number };
    expect(row.last_read_at).toBe(5000);
  });
});

describe('deletion + cascade', () => {
  it('deleteWebchatThread removes its messages + reads; main is not deletable', async () => {
    const t = await createWebchatThread('room-1', 'Q3');
    await storeWebchatMessage('room-1', 'Alice', 'user', 'x', t.thread_id);
    await markThreadRead('u1', 'room-1', t.thread_id, Date.now());

    await deleteWebchatThread('room-1', t.thread_id);
    expect(await getWebchatThread('room-1', t.thread_id)).toBeUndefined();
    expect(await getWebchatMessages('room-1', 200, t.thread_id)).toEqual([]);

    await ensureMainThread('room-1');
    await deleteWebchatThread('room-1', MAIN_THREAD); // no-op
    expect(await getWebchatThread('room-1', MAIN_THREAD)).toBeDefined();
  });

  it('deleteWebchatRoom drops the room threads + thread reads', async () => {
    await ensureMainThread('room-1');
    await createWebchatThread('room-1', 'Q3');
    await markThreadRead('u1', 'room-1', MAIN_THREAD, Date.now());

    await deleteWebchatRoom('room-1');
    expect(await getDb().get(`SELECT COUNT(*) c FROM webchat_threads WHERE room_id='room-1'`)).toEqual({ c: 0 });
    expect(await getDb().get(`SELECT COUNT(*) c FROM webchat_thread_reads WHERE room_id='room-1'`)).toEqual({
      c: 0,
    });
  });
});
