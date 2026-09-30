// ── Current-user routes ──────────────────────────────────────────────────────
// What the signed-in user can ask about themselves.

import { json, readJsonObject } from './http.js';
import { getWebchatUserHandle, setWebchatUserHandle } from '../db.js';
import type { RouteCtx } from '../server.js';

// ── Your @-mention handle (the slug others type to @-mention you) ──────
export async function rMeHandleGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  return json(res, 200, { handle: (await getWebchatUserHandle(userId)) ?? '' });
}

export async function rMeHandlePut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const body = await readJsonObject<{ handle?: unknown }>(req, res);
  if (body === undefined) return;
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : '';
  const result = await setWebchatUserHandle(userId, handle);
  if (!result.ok) {
    return result.reason === 'taken'
      ? json(res, 409, { error: 'That handle is already taken' })
      : json(res, 400, { error: 'Handle must be 1–32 characters: lowercase letters, numbers, and hyphens' });
  }
  return json(res, 200, { ok: true, handle });
}
