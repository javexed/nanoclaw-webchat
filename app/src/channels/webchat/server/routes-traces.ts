// ── Turn traces (../turn-traces.ts) ─────────────────────────────────────────
// A reply's stored trace, read on demand when its Thoughts open, and the
// owner's recording switch + retention.

import { canAccessRoom } from '../access.js';
import { getTurnTraceDays, getTurnTracesEnabled, setTurnTraceDays, setTurnTracesEnabled } from '../db.js';
import type { RouteCtx } from '../server.js';
import { getMessageRoomId, getTraceForMessage, pruneTurnTraces } from '../turn-traces.js';
import { json, readJsonObject } from './http.js';

const MAX_DAYS = 3650;

/** Same gate as reading the room's messages: 404 unknown message, 403 no access, 404 no trace. */
export async function rMessageTraceGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const messageId = decodeURIComponent(m[1]);
  const roomId = await getMessageRoomId(messageId);
  if (!roomId) return json(res, 404, { error: 'Message not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  const stored = await getTraceForMessage(roomId, messageId);
  if (!stored) return json(res, 404, { error: 'No trace for this message' });
  return json(res, 200, {
    message_id: stored.message_id,
    message_ids: stored.message_ids,
    thread_id: stored.thread_id,
    trace: stored.trace,
  });
}

const view = async () => ({ enabled: await getTurnTracesEnabled(), days: await getTurnTraceDays() });

export async function rTurnTracesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, await view());
}

/** {enabled?: boolean, days?: 0 (forever) … 3650}. A shorter window prunes at once. */
export async function rTurnTracesPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const body = await readJsonObject<{ enabled?: unknown; days?: unknown }>(req, res);
  if (body === undefined) return;
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'Expected a JSON object' });
  const { enabled, days } = body;
  if (enabled !== undefined && typeof enabled !== 'boolean')
    return json(res, 400, { error: 'enabled must be a boolean' });
  if (days !== undefined && (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > MAX_DAYS))
    return json(res, 400, { error: `days must be a whole number from 0 (forever) to ${MAX_DAYS}` });
  if (enabled !== undefined) await setTurnTracesEnabled(enabled);
  if (days !== undefined) {
    await setTurnTraceDays(days);
    await pruneTurnTraces();
  }
  return json(res, 200, await view());
}
