// ── User and permission routes ───────────────────────────────────────────────
// The user directory and the grants attached to it: listing users with their
// permissions, deleting a user, granting and revoking a permission, plus the
// per-user credential endpoints that share the same authorisation check.
//
// The rate limiter these share with the credential handlers still in server.ts
// lives in server/rate-limit.ts — see the note there.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { killContainer } from '../../../container-runner.js';
import { userCredsProviderForGroup } from '../../../modules/user-credentials/onboard.js';
import { getAgentGroup, getAllAgentGroups } from '../../../db/agent-groups.js';
import { getDb } from '../../../db/connection.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { getSessionsByAgentGroup } from '../../../db/sessions.js';
import { log } from '../../../log.js';
import {
  addMember as permsAddMember,
  getMembers as permsGetMembers,
  removeMember as permsRemoveMember,
} from '../../../modules/permissions/db/agent-group-members.js';
import {
  getOwners as permsGetOwners,
  getUserRoles as permsGetUserRoles,
  grantRole as permsGrantRole,
  revokeRole as permsRevokeRole,
} from '../../../modules/permissions/db/user-roles.js';
import {
  deleteUser as permsDeleteUser,
  getAllUsers as permsGetAllUsers,
  getUser as permsGetUser,
  upsertUser as permsUpsertUser,
} from '../../../modules/permissions/db/users.js';
import {
  getUserCredential,
  listEnrolledGroups,
  userHasConnectedCredential,
} from '../../../modules/user-credentials/db.js';
import { revokeUserCredential, storeUserCredential } from '../../../modules/user-credentials/onboard.js';
import { getUserSecretId } from '../../../modules/user-credentials/db.js';
import { deleteUserCredential, writeUserCredential } from './grok-user-creds.js';
import { realOnecliAdmin } from '../../../modules/user-credentials/onecli-admin.js';
import { canAccessRoom } from '../access.js';
import { canonicalizeWebchatUserId } from '../auth.js';
import { getAgentsForWebchatRoom, getCredentialsConfig, getEffectiveRoomMode, getWebchatRoom, type CredentialsConfig } from '../db.js';
import { MAX_ACTIVE_MINTS, activeMintCount, cancelMint, mintClaudeToken, startClaudeMint } from '../oauth-mint.js';
import { hasAdminPrivilege, isAnyAdmin, isGlobalAdmin, isOwner } from '../roles.js';
import { userCredsRateLimited } from './rate-limit.js';
import type { RouteCtx } from '../server.js';
import { filterAsync } from '../async-array.js';

// ── UserCreds: a member connects / disconnects THEIR own Anthropic key ──────────
// userId is the server-resolved caller — a user can only manage their own key.
/** Does this workspace accept member SUBSCRIPTIONS for a provider? */
function oauthAllowedFor(provider: string, cfg: CredentialsConfig): boolean {
  if (provider === 'codex') return cfg.allowCodexOauth;
  if (provider === 'grok') return cfg.allowGrokOauth;
  return cfg.allowClaudeOauth;
}

/** Does it accept member API KEYS? Grok has no key path at all, so never. */
function apiKeyAllowedFor(provider: string, cfg: CredentialsConfig): boolean {
  if (provider === 'codex') return cfg.allowOpenaiKey;
  if (provider === 'grok') return false;
  return cfg.allowAnthropicKey;
}

function providerLabel(provider: string): string {
  if (provider === 'codex') return 'Codex (ChatGPT)';
  if (provider === 'grok') return 'Grok';
  return 'Claude';
}

export async function rUserCredentialsCredential(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, url, method, userId } = ctx;
  const reqRoomId = method === 'GET' ? (url.searchParams.get('roomId') ?? '') : undefined; // POST/DELETE read roomId from the body below
  if (method === 'GET') {
    const roomId = decodeURIComponent(reqRoomId ?? '');
    if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
    if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
    const groups = await getAgentsForWebchatRoom(roomId);
    // Effective mode (room override → global default). Credential TYPES are
    // workspace-wide (Credentials admin page); which ones apply here depends on
    // the room's provider (Claude vs Codex).
    const cfg = await getCredentialsConfig();
    const provider = groups[0] ? await userCredsProviderForGroup(groups[0].id) : 'claude';
    // Connection is now user-level (connect once → all same-provider rooms).
    const connected = await userHasConnectedCredential(userId, provider);
    // Report the connected credential type so the UI shows the right banner.
    const credType = (await connected) ? ((await getUserCredential(userId, provider))?.cred_type ?? null) : null;
    return json(res, 200, {
      connected,
      credType,
      provider,
      mode: await getEffectiveRoomMode(roomId),
      oauthAllowed: oauthAllowedFor(provider, cfg),
      // Grok has no API-key path at all, so this is false for it by
      // construction rather than by configuration.
      apiKeyAllowed: apiKeyAllowedFor(provider, cfg),
    });
  }
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { roomId?: unknown; apiKey?: unknown; type?: unknown; token?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const roomId = typeof body.roomId === 'string' ? body.roomId : '';
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  const groups = await getAgentsForWebchatRoom(roomId);
  if (groups.length === 0) return json(res, 400, { error: 'Room has no wired agent' });
  const provider = groups[0] ? await userCredsProviderForGroup(groups[0].id) : 'claude';
  const credType = body.type === 'oauth_token' ? 'oauth_token' : 'api_key';
  const cfg = await getCredentialsConfig();
  // Rate-limit connects (each recreates a vault secret + spawns onecli procs).
  if (method === 'POST' && userCredsRateLimited(userId, 'connect'))
    return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
  try {
    if (method === 'POST' && credType === 'oauth_token') {
      // Gate 1: the workspace must accept this provider's subscriptions (Credentials page).
      if (!oauthAllowedFor(provider, cfg))
        return json(res, 403, {
          error: `This workspace does not accept ${providerLabel(provider)} subscription connections.`,
        });
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (provider === 'codex') {
        // Codex subscription = a whole auth.json (normally produced by the
        // browser mint; pasting it is a fallback). Require valid credential JSON.
        let ok = false;
        try {
          const parsed = JSON.parse(token) as Record<string, unknown>;
          ok = Boolean(parsed.tokens || parsed.OPENAI_API_KEY);
        } catch {
          ok = false;
        }
        if (!ok)
          return json(res, 400, {
            error: 'Expected a Codex auth.json — use “Connect with my ChatGPT subscription” instead of pasting.',
          });
      } else if (provider === 'grok') {
        // A Grok subscription credential is the CLI's own credentials JSON, the
        // artefact of a device login. Require it to parse and to carry both
        // halves: an access token alone cannot be refreshed, and a member whose
        // credential silently stops working in six hours is worse than one who
        // is told now.
        let ok = false;
        try {
          const parsed = JSON.parse(token) as Record<string, unknown>;
          ok = typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string';
        } catch {
          ok = false;
        }
        if (!ok)
          return json(res, 400, {
            error: 'Expected a Grok credential from the device login — use “Connect with my Grok subscription”.',
          });
      } else if (!/^sk-ant-oat/.test(token)) {
        return json(res, 400, {
          error: 'Expected a Claude subscription token from `claude setup-token` (sk-ant-oat…)',
        });
      }
      if (provider === 'grok') {
        // SPLIT AT THE DOOR. The vault gets the ACCESS token only — that is what
        // the gateway injects as a bearer header, and the vault is write-only so
        // nothing can read it back. The REFRESH token stays on the host, because
        // a 6h access token has to be renewed by something that still holds it,
        // and neither the vault nor the container can.
        const parsed = JSON.parse(token) as Record<string, string>;
        await storeUserCredential(realOnecliAdmin, userId, provider, parsed.accessToken, 'oauth_token');
        const secretId = getUserSecretId(userId, 'grok');
        if (secretId) {
          writeUserCredential({
            userId,
            secretId,
            refreshToken: parsed.refreshToken,
            expiresAt: parsed.expiresAt ?? new Date(Date.now() + 6 * 3600_000).toISOString(),
            clientId: parsed.clientId ?? '',
            issuer: parsed.issuer ?? 'https://auth.x.ai',
          });
        }
      } else {
        await storeUserCredential(realOnecliAdmin, userId, provider, token, 'oauth_token');
      }
    } else if (method === 'POST') {
      if (!apiKeyAllowedFor(provider, cfg))
        return json(res, 403, {
          error: `This workspace does not accept ${provider === 'codex' ? 'OpenAI' : 'Anthropic'} API keys.`,
        });
      // API keys are gated by the room's effective mode (OAuth is workspace-wide
      // and allowed even in an OAuth-only 'disabled' room — see the spawn gate).
      // Credentials are user-level, so connecting via a disabled room would
      // otherwise silently enable UserCreds in the member's other rooms.
      if ((await getEffectiveRoomMode(roomId)) === 'disabled')
        return json(res, 403, { error: 'This room does not accept member API keys.' });
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      // Codex: an OpenAI key (sk-…). Claude: an Anthropic key (sk-ant-…).
      if (provider === 'codex') {
        if (!/^sk-/.test(apiKey)) return json(res, 400, { error: 'Expected an OpenAI API key (sk-…)' });
      } else if (!/^sk-ant-/.test(apiKey)) {
        return json(res, 400, { error: 'Expected an Anthropic API key (sk-ant-…)' });
      }
      await storeUserCredential(realOnecliAdmin, userId, provider, apiKey, 'api_key');
    } else {
      // Disconnect: revoke the user-level credential + un-enroll every group.
      // Capture the enrolled groups BEFORE revoke (it clears them) so we can
      // also stop any running per-member container immediately — otherwise it
      // lingers (with its copy of the session) to the idle ceiling.
      const enrolledGroupIds = (await listEnrolledGroups(userId, provider)).map((r) => r.agent_group_id);
      await revokeUserCredential(realOnecliAdmin, userId, provider);
      // Disconnecting must take the host-side half with it. Leaving the refresh
      // token behind would keep renewing a vault secret the member has revoked —
      // a credential that outlives its own disconnect.
      if (provider === 'grok') deleteUserCredential(userId);
      for (const gid of enrolledGroupIds) {
        for (const s of await getSessionsByAgentGroup(gid)) {
          if (s.thread_id === userId) killContainer(s.id, 'UserCreds credential disconnected');
        }
      }
    }
  } catch (err) {
    log.error('UserCreds onboard/revoke failed', { userId, roomId, err: err instanceof Error ? err.message : err });
    return json(res, 502, { error: 'Credential setup failed — check OneCLI is running.' });
  }
  return json(res, 200, { ok: true });
}

// ── UserCreds OAuth browser-mint: get a setup-token without a terminal ──────────
// A member signs in to their Claude subscription entirely in the browser; the
// server runs `claude setup-token` in a throwaway container, scrapes the URL,
// takes the pasted code, captures the token, and stores it as the member's
// user-level credential — the same storage the paste path uses, minus the
// terminal. Same gates as the OAuth paste path: room access + OAuth opt-in.
export async function rUserCredsMintPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { roomId?: unknown; sessionId?: unknown; code?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const step = m[1];
  if (step === 'cancel') {
    if (typeof body.sessionId === 'string') cancelMint(userId, body.sessionId);
    return json(res, 200, { ok: true });
  }
  const roomId = typeof body.roomId === 'string' ? body.roomId : '';
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  if (!(await getCredentialsConfig()).allowClaudeOauth)
    return json(res, 403, { error: 'This workspace does not accept Claude subscription (OAuth) connections.' });
  const groups = await getAgentsForWebchatRoom(roomId);
  if (groups.length === 0) return json(res, 400, { error: 'Room has no wired agent' });
  try {
    if (step === 'start') {
      if (activeMintCount() >= MAX_ACTIVE_MINTS)
        return json(res, 429, { error: 'Too many sign-ins in progress — try again shortly.' });
      if (userCredsRateLimited(userId, 'mint-start'))
        return json(res, 429, { error: 'Too many attempts — wait a moment and try again.' });
      const { sessionId, url: signinUrl } = await startClaudeMint(userId);
      return json(res, 200, { sessionId, url: signinUrl });
    }
    // step === 'code': mint, then onboard.
    if (typeof body.sessionId !== 'string' || typeof body.code !== 'string')
      return json(res, 400, { error: 'sessionId and code required' });
    const token = await mintClaudeToken(userId, body.sessionId, body.code);
    await storeUserCredential(realOnecliAdmin, userId, 'claude', token, 'oauth_token');
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Permissions ───────────────────────────────────────────────────────
// Owners see/do everything. Scoped/global admins can view the permissions
// panel and grant/revoke *member* access on groups they administer; role
// grants (admin/owner) and user deletion stay owner-only since they
// escalate privilege. The /api/users view is scoped per-caller below.
export async function rUsersGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await isAnyAdmin(userId))) return json(res, 403, { error: 'Admin only' });
  return json(res, 200, await listUsersWithPermissions(userId));
}

export async function rUserIdDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  return deleteUserHandler(res, decodeURIComponent(m[1]), userId);
}

export async function rPermissionsGrantPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { userId?: unknown; kind?: unknown; agentGroupId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const granted = await checkMemberGrantAuth(userId, body.kind, body.agentGroupId);
  if (granted) return json(res, 403, granted);
  return grantPermissionHandler(res, body, userId);
}

export async function rPermissionsRevokePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { userId?: unknown; kind?: unknown; agentGroupId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const revoked = await checkMemberGrantAuth(userId, body.kind, body.agentGroupId);
  if (revoked) return json(res, 403, revoked);
  return revokePermissionHandler(res, body);
}

// ── Permissions admin (owner-only) ─────────────────────────────────────
//
// Denormalized "all users + their privilege state" view used by the PWA
// Permissions section. Each role / membership carries its audit pair
// (granted_by + granted_at, or added_by + added_at) so the PWA can show
// per-cell tooltips without a second round-trip.
export interface RoleEntry {
  kind: 'owner' | 'admin';
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

export interface MembershipEntry {
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

export interface UserWithPermissions {
  id: string;
  kind: string;
  display_name: string | null;
  roles: RoleEntry[];
  memberships: MembershipEntry[];
}

export async function listUsersWithPermissions(callerUserId?: string): Promise<UserWithPermissions[]> {
  const users = await permsGetAllUsers();
  const groups = await getAllAgentGroups();
  // Scoping: owners and global admins get the full cross-group matrix. A
  // scoped admin only sees role/membership assignments within the groups they
  // administer — never the global owner/admin roster or other groups' members.
  // The user *list* itself is unfiltered (an admin must be able to add any
  // user as a member of their group), but the per-user roles/memberships are
  // restricted to the caller's administered groups.
  const fullView = !callerUserId || (await isOwner(callerUserId)) || (await isGlobalAdmin(callerUserId));
  const scopedGroupIds = fullView
    ? null
    : new Set((await filterAsync(groups, (g) => hasAdminPrivilege(callerUserId, g.id))).map((g) => g.id));
  const visibleGroups = scopedGroupIds ? groups.filter((g) => scopedGroupIds.has(g.id)) : groups;
  // Pre-fetch members once per group, keep the full audit-rich rows so we
  // can surface added_by / added_at to the UI.
  const membersByGroup = new Map(visibleGroups.map((g) => [g.id, permsGetMembers(g.id)]));

  return Promise.all(
    users.map(async (u) => {
      const roles: RoleEntry[] = (await permsGetUserRoles(u.id))
        .filter((r) => fullView || (r.agent_group_id !== null && scopedGroupIds!.has(r.agent_group_id)))
        .map((r) => ({
          kind: r.role,
          agent_group_id: r.agent_group_id,
          granted_by: r.granted_by,
          granted_at: r.granted_at,
        }));
      const memberships: MembershipEntry[] = [];
      for (const [groupId, members] of membersByGroup) {
        const m = (await members).find((x) => x.user_id === u.id);
        if (m) {
          memberships.push({
            agent_group_id: groupId,
            added_by: m.added_by,
            added_at: m.added_at,
          });
        }
      }
      return {
        id: u.id,
        kind: u.kind,
        display_name: u.display_name ?? null,
        roles,
        memberships,
      };
    }),
  );
}

/**
 * Derive the `users.kind` field from a namespaced user_id like
 * `webchat:tailscale:foo@bar.com`. Used when the owner adds a user who
 * hasn't authenticated yet — we pre-create the row so future grants/queries
 * resolve. Falls back to 'unknown' for ids without a recognised prefix
 * rather than failing the grant entirely; the grant still works because
 * everything keys on `user_id`, kind is just metadata for display.
 */
export function deriveUserKind(userId: string): string {
  const colon = userId.indexOf(':');
  if (colon < 0) return 'unknown';
  return userId.slice(0, colon);
}

export interface GrantBody {
  userId?: unknown;
  kind?: unknown;
  agentGroupId?: unknown;
}

export function validateGrantBody(
  body: GrantBody,
): { error: string } | { userId: string; kind: 'owner' | 'admin' | 'member'; agentGroupId: string | null } {
  const rawUserId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!rawUserId) return { error: 'userId required' };
  if (!rawUserId.includes(':')) return { error: 'userId must be namespaced (e.g. webchat:tailscale:foo@bar.com)' };
  // Fold webchat ids to the canonical form the auth layer mints at login, so a
  // grant matches the eventual session regardless of casing / typed prefix.
  const targetUserId = canonicalizeWebchatUserId(rawUserId);
  const kind = body.kind;
  if (kind !== 'owner' && kind !== 'admin' && kind !== 'member') {
    return { error: 'kind must be one of: owner, admin, member' };
  }
  const agentGroupId =
    body.agentGroupId === null || body.agentGroupId === undefined
      ? null
      : typeof body.agentGroupId === 'string'
        ? body.agentGroupId
        : null;
  if (kind === 'owner' && agentGroupId !== null) {
    return { error: 'owner role is always global; agentGroupId must be null' };
  }
  if (kind === 'member' && agentGroupId === null) {
    return { error: 'member role requires agentGroupId' };
  }
  if (agentGroupId && !getAgentGroup(agentGroupId)) {
    return { error: `agentGroupId ${agentGroupId} does not exist` };
  }
  return { userId: targetUserId, kind, agentGroupId };
}

/**
 * Authorization guard shared by /api/permissions/grant and /revoke.
 *
 * Owners can grant/revoke anything. Everyone else (scoped or global admins)
 * may only touch **member** access, and only on a group they have admin
 * privilege over — `admin`/`owner` grants stay owner-only because they
 * escalate privilege, and cross-group member changes are rejected.
 *
 * Returns `null` when the caller is authorized, otherwise the 403 body to
 * send. This is the privilege boundary for delegated member management;
 * keep it pure and unit-tested (member-grant-auth.test.ts).
 */
export async function checkMemberGrantAuth(
  callerUserId: string,
  kind: unknown,
  agentGroupId: unknown,
): Promise<{ error: string } | null> {
  if (await isOwner(callerUserId)) return null;
  if (kind !== 'member') return { error: 'Owner only' };
  const groupId = typeof agentGroupId === 'string' ? agentGroupId : null;
  if (!groupId || !(await hasAdminPrivilege(callerUserId, groupId))) {
    return { error: 'Admin privilege required for this group' };
  }
  return null;
}

export async function grantPermissionHandler(
  res: ServerResponse,
  body: GrantBody,
  callerUserId: string,
): Promise<void> {
  const parsed = validateGrantBody(body);
  if ('error' in parsed) return json(res, 400, { error: parsed.error });
  const { userId: targetUserId, kind, agentGroupId } = parsed;

  // Upsert the users row so grants on never-seen-before identities work.
  // The kind is derived from the namespace; the display_name is left null
  // and gets populated by the channel adapter on first auth.
  // Await BEFORE negating: `!promise` is always false, so this guard never
  // fired after the async migration — the users-row upsert was skipped and a
  // grant to a never-seen identity died on the user_roles FK. The same
  // negated-guard class the migration cleared elsewhere; this one hid inside a
  // sync handler every codemod skipped.
  if (!(await permsGetUser(targetUserId))) {
    await permsUpsertUser({
      id: targetUserId,
      kind: deriveUserKind(targetUserId),
      display_name: null,
      created_at: new Date().toISOString(),
    });
  }

  const now = new Date().toISOString();
  if (kind === 'member') {
    await permsAddMember({
      user_id: targetUserId,
      agent_group_id: agentGroupId as string,
      added_by: callerUserId,
      added_at: now,
    });
    log.info('Webchat: granted member', { targetUserId, agentGroupId, by: callerUserId });
  } else {
    await permsGrantRole({
      user_id: targetUserId,
      role: kind,
      agent_group_id: agentGroupId,
      granted_by: callerUserId,
      granted_at: now,
    });
    log.info('Webchat: granted role', { targetUserId, role: kind, agentGroupId, by: callerUserId });
  }
  return json(res, 200, { ok: true });
}

/**
 * Refuse to delete a user that still has any roles or memberships — forces
 * the operator to revoke explicitly first, which keeps the audit trail
 * honest. Also refuses to delete the caller themselves (you can't sit on
 * the branch you're sawing).
 */
export async function deleteUserHandler(
  res: ServerResponse,
  targetUserId: string,
  callerUserId: string,
): Promise<void> {
  if (!targetUserId) return json(res, 400, { error: 'userId required' });
  if (targetUserId === callerUserId) {
    return json(res, 409, { error: 'Cannot delete yourself' });
  }
  const target = await permsGetUser(targetUserId);
  if (!target) return json(res, 404, { error: 'User not found' });
  const roles = await permsGetUserRoles(targetUserId);
  if (roles.length > 0) {
    return json(res, 409, {
      error: 'User still has roles — revoke them first',
      remaining_roles: roles.length,
    });
  }
  // Iterate agent_groups to find lingering member rows — there's no
  // direct "memberships for user" helper today, so reuse the listing path.
  for (const g of await getAllAgentGroups()) {
    if ((await permsGetMembers(g.id)).some((m) => m.user_id === targetUserId)) {
      return json(res, 409, { error: 'User still has memberships — revoke them first' });
    }
  }
  // Clean up user_dms cache rows before deleting — user_dms.user_id has a
  // FK reference to users(id) that would otherwise block the delete.
  await getDb().run('DELETE FROM user_dms WHERE user_id = ?', targetUserId);
  await permsDeleteUser(targetUserId);
  log.info('Webchat: deleted user', { targetUserId, by: callerUserId });
  return json(res, 200, { ok: true });
}

export async function revokePermissionHandler(res: ServerResponse, body: GrantBody): Promise<void> {
  const parsed = validateGrantBody(body);
  if ('error' in parsed) return json(res, 400, { error: parsed.error });
  const { userId: targetUserId, kind, agentGroupId } = parsed;

  // Last-owner protection: revoking the only owner would brick the system
  // (no one could grant roles back). Refuse.
  if (kind === 'owner') {
    const owners = await permsGetOwners();
    const stillOwner = owners.filter((o) => o.user_id !== targetUserId);
    if (stillOwner.length === 0) {
      return json(res, 409, { error: 'Cannot revoke the last owner' });
    }
  }

  if (kind === 'member') {
    await permsRemoveMember(targetUserId, agentGroupId as string);
    log.info('Webchat: revoked member', { targetUserId, agentGroupId });
  } else {
    await permsRevokeRole(targetUserId, kind, agentGroupId);
    log.info('Webchat: revoked role', { targetUserId, role: kind, agentGroupId });
  }
  return json(res, 200, { ok: true });
}
