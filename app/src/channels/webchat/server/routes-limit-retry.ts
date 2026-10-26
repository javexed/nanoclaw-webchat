// ── Limit-retry routes ───────────────────────────────────────────────────────
// Schedule and cancel a room thread's "retry when the limit lifts" (../limit-retry.ts).
import { cancelLimitRetry, scheduleLimitRetry } from '../limit-retry.js';
import { MAIN_THREAD } from '../db.js';
import type { RouteCtx } from '../server.js';
import { json, readJsonObject } from './http.js';
import { requireRoomAccess } from './route-guards.js';

/** POST { message_id }: re-send the caller's last message there when the notice's limit resets. */
export async function rLimitRetryPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const roomId = await requireRoomAccess(ctx, m);
  if (roomId === undefined) return;
  const body = await readJsonObject<{ message_id?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  const noticeId = typeof body?.message_id === 'string' ? body.message_id : '';
  if (!noticeId) return json(ctx.res, 400, { error: 'message_id required' });
  const r = await scheduleLimitRetry(roomId, noticeId, ctx.userId);
  if (!r.ok) {
    // A 409 for a thread that already has one carries it, so the client can show it.
    return json(ctx.res, r.status, {
      error: r.error,
      retry_at: r.retry?.retry_at ?? null,
      notice_id: r.retry?.notice_id ?? null,
      by: r.retry?.sender ?? null,
    });
  }
  return json(ctx.res, 200, {
    thread_id: r.retry.thread_id,
    notice_id: r.retry.notice_id,
    retry_at: r.retry.retry_at,
    by: r.retry.sender,
  });
}

/** DELETE ?thread_id=: cancel that thread's pending retry. */
export async function rLimitRetryDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const roomId = await requireRoomAccess(ctx, m);
  if (roomId === undefined) return;
  const threadId = ctx.url.searchParams.get('thread_id') || MAIN_THREAD;
  const r = await cancelLimitRetry(roomId, threadId, ctx.userId);
  if (!r.ok) return json(ctx.res, r.status, { error: r.error });
  return json(ctx.res, 200, { ok: true });
}
