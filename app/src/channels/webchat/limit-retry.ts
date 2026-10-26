/**
 * "Retry when the limit lifts": when an agent's reply is a rate-limit notice
 * that says when the limit resets, the person who hit it can have their last
 * message in that thread sent again at the reset.
 *
 * The runner writes the reset beside the notice's text (`limitResetsAt`,
 * container limit-reset.ts); deliver() stores it on the notice row. Scheduling
 * stores the message to re-send in `webchat_limit_retries`, one per room
 * thread. A sweep sends it when due, exactly as if its sender had typed it
 * again: stored, broadcast, and handed to the router, which runs its own access
 * checks. Access to the room is checked again at send time, since it can be
 * lost while the retry waits.
 *
 * The retry is a host row, not a messages_in row with process_after or a
 * scheduled task: those go straight to one session and skip both the router
 * and the transcript, so the re-sent message would neither show in the room nor
 * pass the checks a typed one does. It is not a browser timer either: the
 * retry has to happen with every tab closed.
 */
import { randomUUID } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';
import { registerModuleSweep } from '../../module-sweep.js';
import type { InboundMessage } from '../adapter.js';

import { canAccessRoom, canArchiveRoom } from './access.js';
import {
  MAIN_THREAD,
  getWebchatRoom,
  getWebchatThread,
  markThreadRead,
  storeWebchatMessage,
  threadToSessionKey,
} from './db.js';
import { broadcast, markRoomReadForUser } from './state.js';

/** The content field the runner writes the reset into (container limit-reset.ts). */
export const LIMIT_RESETS_AT_FIELD = 'limitResetsAt';

/** Spread retries after a shared reset, so they don't all land on the same second. */
export const JITTER_MIN_MS = 10_000;
export const JITTER_MAX_MS = 60_000;
const SWEEP_MS = 15_000;

/** The reset a delivery carries (epoch ms), or null for every other delivery. */
export function limitResetsAtOf(content: unknown): number | null {
  if (!content || typeof content !== 'object') return null;
  const v = (content as Record<string, unknown>)[LIMIT_RESETS_AT_FIELD];
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export interface LimitRetry {
  id: string;
  room_id: string;
  thread_id: string;
  notice_id: string;
  user_id: string;
  sender: string;
  sender_type: string;
  content: string;
  retry_at: number;
  created_at: number;
}

export type ScheduleResult =
  | { ok: true; retry: LimitRetry }
  | { ok: false; status: 404 | 409; error: string; retry?: LimitRetry };

async function pendingFor(roomId: string, threadId: string): Promise<LimitRetry | undefined> {
  return (await getDb().get(
    `SELECT * FROM webchat_limit_retries WHERE room_id = ? AND thread_id = ?`,
    roomId,
    threadId,
  )) as LimitRetry | undefined;
}

/**
 * What clients are told about a thread's retry; `retry_at: null` means none is
 * pending. `by` is the scheduler's sender name, so a client can offer Cancel to
 * them (the server still decides: cancelLimitRetry).
 */
function announce(
  roomId: string,
  threadId: string,
  noticeId: string,
  retryAt: number | null,
  by: string | null = null,
): Promise<void> {
  return broadcast(roomId, {
    type: 'limit_retry',
    room_id: roomId,
    thread_id: threadId,
    notice_id: noticeId,
    retry_at: retryAt,
    by,
  });
}

/**
 * Schedule a re-send of `userId`'s last message before the notice, in the
 * notice's thread, at its reset plus jitter. One per thread: a second request
 * gets the pending one back with a 409.
 */
export async function scheduleLimitRetry(
  roomId: string,
  noticeId: string,
  userId: string,
  now = Date.now(),
  jitter = () => JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS)),
): Promise<ScheduleResult> {
  const notice = (await getDb().get(
    `SELECT id, thread_id, created_at, limit_resets_at FROM webchat_messages WHERE id = ? AND room_id = ?`,
    noticeId,
    roomId,
  )) as { id: string; thread_id: string; created_at: number; limit_resets_at: number | null } | undefined;
  if (!notice || notice.limit_resets_at == null) return { ok: false, status: 404, error: 'No limit notice' };
  if (notice.limit_resets_at <= now) return { ok: false, status: 409, error: 'The limit has already reset' };
  const existing = await pendingFor(roomId, notice.thread_id);
  if (existing) return { ok: false, status: 409, error: 'A retry is already scheduled', retry: existing };

  const last = (await getDb().get(
    `SELECT sender, sender_type, content FROM webchat_messages
      WHERE room_id = ? AND thread_id = ? AND sender_user_id = ? AND message_type = 'text'
        AND created_at <= ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    roomId,
    notice.thread_id,
    userId,
    notice.created_at,
  )) as { sender: string; sender_type: string; content: string } | undefined;
  if (!last) return { ok: false, status: 409, error: 'Nothing to retry' };

  const retry: LimitRetry = {
    id: randomUUID(),
    room_id: roomId,
    thread_id: notice.thread_id,
    notice_id: notice.id,
    user_id: userId,
    sender: last.sender,
    sender_type: last.sender_type,
    content: last.content,
    retry_at: notice.limit_resets_at + jitter(),
    created_at: now,
  };
  // The unique (room_id, thread_id) index settles a race between two requests.
  const res = (await getDb().run(
    `INSERT INTO webchat_limit_retries
       (id, room_id, thread_id, notice_id, user_id, sender, sender_type, content, retry_at, created_at)
     VALUES (@id, @room_id, @thread_id, @notice_id, @user_id, @sender, @sender_type, @content, @retry_at, @created_at)
     ON CONFLICT (room_id, thread_id) DO NOTHING`,
    { ...retry },
  )) as { changes?: number } | undefined;
  if (!res?.changes) {
    return {
      ok: false,
      status: 409,
      error: 'A retry is already scheduled',
      retry: await pendingFor(roomId, notice.thread_id),
    };
  }
  await announce(roomId, retry.thread_id, retry.notice_id, retry.retry_at, retry.sender);
  return { ok: true, retry };
}

/** Cancel the thread's pending retry: its scheduler, or an admin of the room. */
export async function cancelLimitRetry(
  roomId: string,
  threadId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> {
  const retry = await pendingFor(roomId, threadId);
  if (!retry) return { ok: false, status: 404, error: 'No retry scheduled' };
  if (retry.user_id !== userId && !(await canArchiveRoom(userId, roomId))) {
    return { ok: false, status: 403, error: 'Only who scheduled it can cancel it' };
  }
  await getDb().run(`DELETE FROM webchat_limit_retries WHERE id = ?`, retry.id);
  await announce(roomId, threadId, retry.notice_id, null);
  return { ok: true };
}

/**
 * Mark the notices with a pending retry (`limit_retry_at`, and its scheduler's
 * sender name as `limit_retry_by`), for history payloads.
 */
export async function withLimitRetries<T extends { id: string; limit_resets_at?: number }>(
  messages: T[],
): Promise<(T & { limit_retry_at?: number; limit_retry_by?: string })[]> {
  const notices = messages.filter((m) => m.limit_resets_at != null);
  if (notices.length === 0) return messages;
  const rows = (await getDb().all(
    `SELECT notice_id, retry_at, sender FROM webchat_limit_retries WHERE notice_id IN (${notices.map(() => '?').join(',')})`,
    ...notices.map((m) => m.id),
  )) as { notice_id: string; retry_at: number; sender: string }[];
  if (rows.length === 0) return messages;
  const pending = new Map(rows.map((r) => [r.notice_id, r]));
  return messages.map((m) => {
    const r = pending.get(m.id);
    return r ? { ...m, limit_retry_at: r.retry_at, limit_retry_by: r.sender } : m;
  });
}

type Inbound = (roomId: string, message: InboundMessage, threadId: string | null) => void;
let inbound: Inbound | null = null;

/** Where due retries are handed, as a typed message is (the adapter's onInbound). */
export function setLimitRetryInbound(fn: Inbound | null): void {
  inbound = fn;
}

/**
 * Send every due retry. Each row is claimed by deleting it, so a retry is sent
 * at most once; one that fails before its message is stored is put back for
 * the next sweep. One failing retry never stops the rest.
 */
export async function sendDueLimitRetries(now = Date.now()): Promise<number> {
  const hand = inbound;
  if (!hand || !(await hasTable(getDb(), 'webchat_limit_retries'))) return 0;
  const due = (await getDb().all(
    `SELECT * FROM webchat_limit_retries WHERE retry_at <= ? ORDER BY retry_at`,
    now,
  )) as LimitRetry[];
  let sent = 0;
  for (const r of due) {
    try {
      if (await sendOne(r, hand)) sent++;
    } catch (err) {
      log.warn('Webchat: limit retry failed', { roomId: r.room_id, err: String(err) });
    }
  }
  return sent;
}

async function threadExists(r: LimitRetry): Promise<boolean> {
  return r.thread_id === MAIN_THREAD || !!(await getWebchatThread(r.room_id, r.thread_id));
}

/** Put a claimed retry back, unless the thread has scheduled a new one since. */
async function restore(r: LimitRetry): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_limit_retries
       (id, room_id, thread_id, notice_id, user_id, sender, sender_type, content, retry_at, created_at)
     VALUES (@id, @room_id, @thread_id, @notice_id, @user_id, @sender, @sender_type, @content, @retry_at, @created_at)
     ON CONFLICT DO NOTHING`,
    { ...r },
  );
}

async function sendOne(r: LimitRetry, hand: Inbound): Promise<boolean> {
  const claimed = (await getDb().run(`DELETE FROM webchat_limit_retries WHERE id = ?`, r.id)) as
    | { changes?: number }
    | undefined;
  if (!claimed?.changes) return false;
  let stored: Awaited<ReturnType<typeof storeWebchatMessage>>;
  try {
    if (!(await getWebchatRoom(r.room_id))) return false;
    if (!(await threadExists(r))) {
      log.info('Webchat: limit retry dropped, its thread was deleted', { roomId: r.room_id });
      return false;
    }
    if (!(await canAccessRoom(r.user_id, r.room_id))) {
      await announce(r.room_id, r.thread_id, r.notice_id, null);
      log.info('Webchat: limit retry dropped, sender lost access to the room', { roomId: r.room_id });
      return false;
    }
    stored = await storeWebchatMessage(r.room_id, r.sender, r.sender_type, r.content, r.thread_id, r.user_id);
  } catch (err) {
    await restore(r);
    throw err;
  }
  // From here the message is in the transcript, so it is never put back: a
  // second copy would be worse than a missed hand-off.
  await announce(r.room_id, r.thread_id, r.notice_id, null);
  // As for a typed message: the sender has read their own message, on every
  // device, and is not notified of it.
  markRoomReadForUser(r.user_id, r.room_id, stored.created_at);
  await markThreadRead(r.user_id, r.room_id, r.thread_id, stored.created_at);
  await broadcast(r.room_id, { type: 'message', ...stored }, undefined, r.user_id);
  hand(
    r.room_id,
    {
      id: stored.id,
      kind: 'chat',
      timestamp: new Date(stored.created_at).toISOString(),
      isGroup: true,
      content: { text: r.content, sender: r.sender, senderId: r.user_id, senderName: r.sender },
    },
    threadToSessionKey(r.thread_id),
  );
  return true;
}

registerModuleSweep('webchat-limit-retries', async () => void (await sendDueLimitRetries()), SWEEP_MS);
