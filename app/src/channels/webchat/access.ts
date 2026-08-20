/**
 * Per-room access control.
 *
 * Webchat rooms are messaging_groups rows wired to one or more agent groups
 * via messaging_group_agents. A user has access to a room if they have
 * access to *any* of the agents wired to it. Agent-group access is
 * delegated to the cross-channel permissions module so the policy stays
 * consistent with command-gate, approvals, etc.
 */
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
import { getAgentsForWebchatRoom } from './db.js';
import type { WebchatRoom } from './db.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from './roles.js';
import { filterAsync } from './async-array.js';

export async function canAccessRoom(userId: string, roomId: string): Promise<boolean> {
  const agents = await getAgentsForWebchatRoom(roomId);
  if (agents.length === 0) return false;
  for (const a of agents) {
    if ((await canAccessAgentGroup(userId, a.id)).allowed) return true;
  }
  return false;
}

export async function filterRoomsForUser<T extends WebchatRoom>(userId: string, rooms: T[]): Promise<T[]> {
  // filterAsync, not filter: canAccessRoom is async now, and a native filter
  // would test the PROMISE — keeping every room for every user.
  return filterAsync(rooms, (r) => canAccessRoom(userId, r.id));
}

/**
 * Authorize the global-archive / unarchive operation on a room. Wider than
 * just access (any member can SEE a room) but narrower than full owner-only
 * — scoped admins of any agent wired to the room can archive too. Owner +
 * global admin always pass.
 */
export async function canArchiveRoom(userId: string, roomId: string): Promise<boolean> {
  if ((await isOwner(userId)) || (await isGlobalAdmin(userId))) return true;
  const agents = await getAgentsForWebchatRoom(roomId);
  for (const a of await agents) {
    if ((await hasAdminPrivilege(userId, a.id))) return true;
  }
  return false;
}
