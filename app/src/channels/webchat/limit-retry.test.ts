/**
 * "Retry when the limit lifts": a rate-limit notice keeps its reset, a person
 * can schedule one re-send of their last message per thread, and the sweep
 * sends it once due — through the inbound hook, as a typed message — only if
 * they can still reach the room.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

const access = vi.hoisted(() => ({ room: true, admin: false }));
const sent = vi.hoisted(() => [] as Array<{ roomId: string; msg: Record<string, unknown>; senderUserId?: string }>);
const roomReads = vi.hoisted(() => [] as Array<{ userId: string; roomId: string; ts: number }>);
const failStore = vi.hoisted(() => ({ thread: null as string | null }));

vi.mock('./access.js', () => ({
  canAccessRoom: async () => access.room,
  canArchiveRoom: async () => access.admin,
}));
vi.mock('./state.js', () => ({
  broadcast: async (roomId: string, msg: Record<string, unknown>, _exclude?: string, senderUserId?: string) =>
    void sent.push({ roomId, msg, senderUserId }),
  markRoomReadForUser: (userId: string, roomId: string, ts: number) => void roomReads.push({ userId, roomId, ts }),
}));
vi.mock('./db.js', async (orig) => {
  const real = await orig<typeof import('./db.js')>();
  return {
    ...real,
    getWebchatRoom: async (id: string) => (id === 'gone' ? undefined : { id, name: id }),
    storeWebchatMessage: async (...args: Parameters<typeof real.storeWebchatMessage>) => {
      if (failStore.thread !== null && args[4] === failStore.thread) throw new Error('disk full');
      return real.storeWebchatMessage(...args);
    },
  };
});

import { storeAgentDelivery } from './agent-delivery.js';
import { deleteWebchatThread, ensureThread, getWebchatMessages, storeWebchatMessage } from './db.js';
import {
  JITTER_MAX_MS,
  JITTER_MIN_MS,
  cancelLimitRetry,
  limitResetsAtOf,
  scheduleLimitRetry,
  sendDueLimitRetries,
  setLimitRetryInbound,
  withLimitRetries,
} from './limit-retry.js';

const RESET = Date.parse('2031-01-01T05:00:00.000Z');
const BEFORE = RESET - 60 * 60 * 1000;
const inbound = vi.fn();

// Messages a second apart, as in a real room: the last-message lookup orders by time.
let clock = BEFORE - 10 * 60 * 1000;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
  await initTestDb();
  await runMigrations(getDb());
  access.room = true;
  access.admin = false;
  sent.length = 0;
  roomReads.length = 0;
  failStore.thread = null;
  inbound.mockReset();
  setLimitRetryInbound(inbound);
});

afterEach(async () => {
  vi.restoreAllMocks();
  clock = BEFORE - 10 * 60 * 1000;
  setLimitRetryInbound(null);
  await closeDb();
});

async function notice(roomId = 'room-1', thread = 'main'): Promise<string> {
  const id = await storeAgentDelivery(
    { broadcast: () => {}, persistOutboundFile: () => '' },
    {
      key: `k-${Math.random()}`,
      roomId,
      senderName: 'Agent',
      text: "I've hit the API rate limit",
      files: undefined,
      thread,
      limitResetsAt: limitResetsAtOf({ text: 'x', limitResetsAt: new Date(RESET).toISOString() }),
    },
  );
  return id!;
}

describe('limitResetsAtOf', () => {
  it('reads the runner field, and nothing else', () => {
    expect(limitResetsAtOf({ text: 'x', limitResetsAt: '2031-01-01T05:00:00.000Z' })).toBe(RESET);
    expect(limitResetsAtOf({ text: 'x' })).toBeNull();
    expect(limitResetsAtOf({ text: 'x', limitResetsAt: 'soon' })).toBeNull();
    expect(limitResetsAtOf('plain text')).toBeNull();
  });
});

describe('the notice', () => {
  it('keeps its reset; other messages carry none', async () => {
    await storeWebchatMessage('room-1', 'Alice', 'user', 'hello', 'main', 'webchat:alice');
    const id = await notice();
    const rows = await getWebchatMessages('room-1');
    expect(rows.find((m) => m.id === id)).toMatchObject({ limit_resets_at: RESET });
    expect(rows.find((m) => m.id !== id)).not.toHaveProperty('limit_resets_at');
  });
});

describe('scheduleLimitRetry', () => {
  it("re-sends the caller's own last message in the thread, at the reset plus jitter", async () => {
    await storeWebchatMessage('room-1', 'Alice', 'user', 'first', 'main', 'webchat:alice');
    await storeWebchatMessage('room-1', 'Alice', 'user', 'second', 'main', 'webchat:alice');
    await storeWebchatMessage('room-1', 'Bob', 'user', 'from bob', 'main', 'webchat:bob');
    await storeWebchatMessage('room-1', 'Alice', 'user', 'other thread', 't1', 'webchat:alice');
    const id = await notice();
    const r = await scheduleLimitRetry('room-1', id, 'webchat:alice', BEFORE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.retry.content).toBe('second');
    expect(r.retry.retry_at).toBeGreaterThanOrEqual(RESET + JITTER_MIN_MS);
    expect(r.retry.retry_at).toBeLessThan(RESET + JITTER_MAX_MS);
    expect(sent.at(-1)?.msg).toMatchObject({
      type: 'limit_retry',
      notice_id: id,
      retry_at: r.retry.retry_at,
      by: 'Alice',
    });
  });

  it('keeps one pending retry per thread', async () => {
    await storeWebchatMessage('room-1', 'Alice', 'user', 'hi', 'main', 'webchat:alice');
    await storeWebchatMessage('room-1', 'Bob', 'user', 'yo', 'main', 'webchat:bob');
    const id = await notice();
    const first = await scheduleLimitRetry('room-1', id, 'webchat:alice', BEFORE);
    const second = await scheduleLimitRetry('room-1', id, 'webchat:bob', BEFORE);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, status: 409 });
    if (!second.ok && first.ok) expect(second.retry?.id).toBe(first.retry.id);
  });

  it('refuses without a reset ahead, or with nothing to re-send', async () => {
    const plain = await storeWebchatMessage('room-1', 'Agent', 'agent', 'just text');
    expect(await scheduleLimitRetry('room-1', plain.id, 'webchat:alice', BEFORE)).toMatchObject({ status: 404 });
    const id = await notice();
    expect(await scheduleLimitRetry('room-1', id, 'webchat:alice', BEFORE)).toMatchObject({
      status: 409,
      error: 'Nothing to retry',
    });
    await storeWebchatMessage('room-1', 'Alice', 'user', 'late', 'main', 'webchat:alice');
    expect(await scheduleLimitRetry('room-1', id, 'webchat:alice', RESET + 1)).toMatchObject({ status: 409 });
    expect(await scheduleLimitRetry('room-2', id, 'webchat:alice', BEFORE)).toMatchObject({ status: 404 });
  });
});

describe('cancelLimitRetry', () => {
  it('lets the scheduler or a room admin cancel, nobody else', async () => {
    await storeWebchatMessage('room-1', 'Alice', 'user', 'hi', 'main', 'webchat:alice');
    const id = await notice();
    await scheduleLimitRetry('room-1', id, 'webchat:alice', BEFORE);
    expect(await cancelLimitRetry('room-1', 'main', 'webchat:bob')).toMatchObject({ status: 403 });
    access.admin = true;
    expect(await cancelLimitRetry('room-1', 'main', 'webchat:bob')).toEqual({ ok: true });
    expect(sent.at(-1)?.msg).toMatchObject({ type: 'limit_retry', notice_id: id, retry_at: null });
    expect(await cancelLimitRetry('room-1', 'main', 'webchat:alice')).toMatchObject({ status: 404 });
  });
});

describe('withLimitRetries', () => {
  it('marks the notice that has a pending retry', async () => {
    await storeWebchatMessage('room-1', 'Alice', 'user', 'hi', 'main', 'webchat:alice');
    const id = await notice();
    const r = await scheduleLimitRetry('room-1', id, 'webchat:alice', BEFORE);
    const marked = await withLimitRetries(await getWebchatMessages('room-1'));
    expect(marked.find((m) => m.id === id)).toMatchObject({
      limit_retry_at: r.ok ? r.retry.retry_at : -1,
      limit_retry_by: 'Alice',
    });
    expect(marked.filter((m) => 'limit_retry_at' in m)).toHaveLength(1);
  });
});

describe('sendDueLimitRetries', () => {
  async function scheduled(thread = 'main'): Promise<number> {
    if (thread !== 'main') await ensureThread('room-1', thread, thread, 'topic');
    await storeWebchatMessage('room-1', 'Alice', 'user', 'try again', thread, 'webchat:alice');
    const id = await notice('room-1', thread);
    const r = await scheduleLimitRetry('room-1', id, 'webchat:alice', BEFORE);
    if (!r.ok) throw new Error(r.error);
    return r.retry.retry_at;
  }

  it('sends nothing before it is due', async () => {
    const at = await scheduled();
    expect(await sendDueLimitRetries(at - 1)).toBe(0);
    expect(inbound).not.toHaveBeenCalled();
  });

  it('sends it once, as the person, into the thread, through the inbound hook', async () => {
    const at = await scheduled('t1');
    expect(await sendDueLimitRetries(at)).toBe(1);
    expect(await sendDueLimitRetries(at + 60_000)).toBe(0);
    expect(inbound).toHaveBeenCalledTimes(1);
    const [roomId, msg, sessionKey] = inbound.mock.calls[0]!;
    expect(roomId).toBe('room-1');
    expect(sessionKey).toBe('t1');
    expect(msg.content).toMatchObject({ text: 'try again', senderId: 'webchat:alice', sender: 'Alice' });
    const stored = (await getWebchatMessages('room-1', 50, 't1')).filter((m) => m.content === 'try again');
    expect(stored).toHaveLength(2);
    expect(sent.some((s) => s.msg.type === 'message' && s.msg.id === msg.id)).toBe(true);
    expect(sent.at(-2)?.msg).toMatchObject({ type: 'limit_retry', retry_at: null });
  });

  it('reads as a typed message: read for its sender, who is not notified of it', async () => {
    const at = await scheduled('t1');
    expect(await sendDueLimitRetries(at)).toBe(1);
    const msg = sent.find((s) => s.msg.type === 'message')!;
    expect(msg.senderUserId).toBe('webchat:alice');
    expect(roomReads).toEqual([{ userId: 'webchat:alice', roomId: 'room-1', ts: msg.msg.created_at }]);
    const read = (await getDb().get(
      `SELECT last_read_at FROM webchat_thread_reads WHERE user_id = ? AND room_id = ? AND thread_id = ?`,
      'webchat:alice',
      'room-1',
      't1',
    )) as { last_read_at: number } | undefined;
    expect(read?.last_read_at).toBe(msg.msg.created_at);
  });

  it('goes with its thread when the thread is deleted', async () => {
    const at = await scheduled('t1');
    await deleteWebchatThread('room-1', 't1');
    expect(await getDb().all(`SELECT id FROM webchat_limit_retries`)).toHaveLength(0);
    expect(await sendDueLimitRetries(at)).toBe(0);
    expect(inbound).not.toHaveBeenCalled();
  });

  it('never sends into a thread that no longer exists', async () => {
    const at = await scheduled('t1');
    await getDb().run(`DELETE FROM webchat_threads WHERE room_id = 'room-1' AND thread_id = 't1'`);
    expect(await sendDueLimitRetries(at)).toBe(0);
    expect(inbound).not.toHaveBeenCalled();
    const copies = (await getWebchatMessages('room-1', 50, 't1')).filter((m) => m.content === 'try again');
    expect(copies).toHaveLength(1);
  });

  it('keeps a retry that fails to send, and still sends the others', async () => {
    const first = await scheduled('t1');
    const second = await scheduled('t2');
    failStore.thread = 't1';
    expect(await sendDueLimitRetries(Math.max(first, second))).toBe(1);
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(inbound.mock.calls[0]![2]).toBe('t2');
    expect(await getDb().all(`SELECT thread_id FROM webchat_limit_retries`)).toEqual([{ thread_id: 't1' }]);
    failStore.thread = null;
    expect(await sendDueLimitRetries(Math.max(first, second))).toBe(1);
    expect(inbound.mock.calls[1]![2]).toBe('t1');
  });

  it('drops it when the person can no longer reach the room', async () => {
    const at = await scheduled();
    access.room = false;
    expect(await sendDueLimitRetries(at)).toBe(0);
    expect(inbound).not.toHaveBeenCalled();
    expect(await getDb().all(`SELECT id FROM webchat_limit_retries`)).toHaveLength(0);
  });
});
