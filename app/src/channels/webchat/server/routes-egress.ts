// ── Egress allowlist routes ──────────────────────────────────────────────
// Manage → Network: the install-wide egress allowlist every filtered agent
// uses (egress-policy.ts allowlistFor). Owner /
// global-admin only (the 'globalAdmin' guard in server.ts).
import { json, readJsonObject } from './http.js';
import {
  ALWAYS_ALLOWED,
  defaultAllowlist,
  getRunnerEgressAllowlist,
  listBlocked,
  parseAllowlist,
  setRunnerEgressAllowlist,
} from '../egress-policy.js';
import type { RouteCtx } from '../server.js';

/** The install's egress policy for every agent (egress-policy.ts): allowlist, defaults, recently blocked. */
export async function rEgressGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  return json(ctx.res, 200, {
    allowlist: await getRunnerEgressAllowlist(),
    defaults: defaultAllowlist(),
    always: ALWAYS_ALLOWED,
    blocked: listBlocked(),
  });
}

export async function rEgressPut(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const body = await readJsonObject<{ allowlist?: unknown }>(ctx.req, ctx.res);
  if (body === undefined) return;
  const parsed = parseAllowlist(body.allowlist);
  if (!parsed.ok) return json(ctx.res, 400, { error: parsed.error });
  await setRunnerEgressAllowlist(parsed.patterns);
  return json(ctx.res, 200, { allowlist: parsed.patterns, blocked: listBlocked() });
}
