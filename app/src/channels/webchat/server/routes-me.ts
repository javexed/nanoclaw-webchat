// ── Current-user routes ──────────────────────────────────────────────────────
// What the signed-in user can ask about themselves. Two handlers, no helpers
// and nothing shared beyond RouteCtx — the smallest cluster in server.ts, and
// the only one that came out with no shared layer at all.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { getWebchatUserHandle, setWebchatUserHandle } from '../db.js';
import type { RouteCtx } from '../server.js';

// ── Your @-mention handle (the slug others type to @-mention you) ──────
export async function rMeHandleGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  return json(res, 200, { handle: getWebchatUserHandle(userId) ?? '' });
}

export async function rMeHandlePut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { handle?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : '';
  const result = setWebchatUserHandle(userId, handle);
  if (!result.ok) {
    return result.reason === 'taken'
      ? json(res, 409, { error: 'That handle is already taken' })
      : json(res, 400, { error: 'Handle must be 1–32 characters: lowercase letters, numbers, and hyphens' });
  }
  return json(res, 200, { ok: true, handle });
}
