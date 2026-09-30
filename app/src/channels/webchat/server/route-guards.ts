// ── Per-resource route guards ────────────────────────────────────────────────
// The :id lookups most handlers open with. Each sends its 404 before its 403,
// and returns undefined once it has answered.
import type { AgentGroup } from '../../../types.js';
import { canAccessRoom } from '../access.js';
import { getWebchatRoom } from '../db.js';
import { hasAdminPrivilege } from '../roles.js';
import type { RouteCtx } from '../server.js';
import { resolveAgent } from './agent-lookup.js';
import { json } from './http.js';

/** The agent named by m[1], when the caller is an admin over it. */
export async function requireAgentAdmin(ctx: RouteCtx, m: RegExpMatchArray): Promise<AgentGroup | undefined> {
  const group = await resolveAgent(decodeURIComponent(m[1]));
  if (!group) return void json(ctx.res, 404, { error: 'Agent not found' });
  if (!(await hasAdminPrivilege(ctx.userId, group.id)))
    return void json(ctx.res, 403, { error: 'Admin privilege required' });
  return group;
}

/** The room id in m[1], when that room exists and the caller may access it. */
export async function requireRoomAccess(ctx: RouteCtx, m: RegExpMatchArray): Promise<string | undefined> {
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return void json(ctx.res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(ctx.userId, roomId))) return void json(ctx.res, 403, { error: 'Access denied' });
  return roomId;
}
