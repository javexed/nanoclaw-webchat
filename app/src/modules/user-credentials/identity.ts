/**
 * UserCreds identity helpers.
 *
 * A per-member webchat session runs in a container bearing a per-(user, agent
 * group) OneCLI agent identity, so the gateway injects THAT user's Anthropic
 * key (plus the group's other tool secrets) based on the identity it trusts at
 * spawn. There is no per-turn token to replay.
 *
 * OneCLI agent identifiers must be lowercase `[a-z0-9-]` — so we can't embed
 * the raw user id (which contains `:`/`@`) or split a composite on `:`. The
 * identifier is `user-creds-<userSlug>-<hash>`; the host recovers the owning agent
 * group via the `user_credential_members` table (onecli_agent_id → agent_group_id),
 * not by parsing the identifier.
 */
import crypto from 'crypto';

const ID_PREFIX = 'user-creds-';

/**
 * Reserved synthetic user id for the WORKSPACE DEFAULT Anthropic credential — the
 * owner/global-admin-managed fallback that any agent session uses when its member
 * has NOT connected their own user credential. Stored through the same
 * `user_credentials` table + OneCLI `anthropic` secret machinery as a real member,
 * but under this id it is deliberately NEVER enrolled onto a per-member agent
 * (`ensureGroupEnrollment` must skip it): it stays an unassigned, `all`-mode
 * workspace secret that base agents auto-inject. It never authenticates, so it
 * can't collide with a real `<channel>:<handle>` user id.
 */
export const WORKSPACE_DEFAULT_USER_ID = 'workspace-default';

/** True for the reserved workspace-default id — guards it out of member/enrollment paths. */
export function isWorkspaceDefaultUser(userId: string): boolean {
  return userId === WORKSPACE_DEFAULT_USER_ID;
}

/** A readable, valid-charset slug of a namespaced user id (e.g. `webchat:tailscale:a@x.com`). */
export function userSlug(userId: string): string {
  const base = userId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return base || 'user';
}

/**
 * Deterministic, collision-resistant, valid OneCLI identifier for a
 * (agent group, user) pair. Same input → same identifier (idempotent
 * onboarding + spawn must agree).
 */
export function userCredsAgentIdentifier(agentGroupId: string, userId: string): string {
  const hash = crypto.createHash('sha256').update(`${agentGroupId}|${userId}`).digest('hex').slice(0, 12);
  return `${ID_PREFIX}${userSlug(userId)}-${hash}`;
}

/**
 * Per-member SESSION KEY codec: (user, thread) -> the session's thread_id.
 *
 * A per-member session used to be keyed by user ALONE, which collapsed every
 * thread in a room into one session. That is not cosmetic: one member's queue
 * ended up holding 89 main-thread rows and 60 topic-thread rows, and the agent
 * answered a message posted in the room into the topic thread instead. Keying
 * by (user, thread) keeps each thread its own session and its own history.
 *
 * Separator is `::` because user ids already contain single colons
 * (`webchat:tailscale:a@x.com`) while thread ids are UUIDs or `main` — neither
 * contains `::`. Decoding splits on the LAST `::` so a user id's own colons can
 * never be mistaken for the boundary.
 *
 * `main` is encoded explicitly rather than left empty, so the room and a topic
 * thread are always distinct keys and neither can collide with a bare user id.
 */
const KEY_SEP = '::';
const MAIN_THREAD_KEY = 'main';

export function memberSessionKey(userId: string, threadId: string | null | undefined): string {
  return `${userId}${KEY_SEP}${threadId || MAIN_THREAD_KEY}`;
}

/**
 * The user half of a per-member session key, or null when this is not one.
 *
 * Null for a BARE user id — the pre-composite shape still in the sessions table.
 * Callers therefore read `memberUserFromKey(x) ?? x`, which keeps existing
 * per-member sessions resolving to the right credential identity instead of
 * silently falling back to the workspace default (a container would keep
 * running, on the wrong identity — the failure this codec exists to prevent).
 */
export function memberUserFromKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const i = key.lastIndexOf(KEY_SEP);
  return i > 0 ? key.slice(0, i) : null;
}

/** The thread half of a per-member session key, or null when this is not one. */
export function memberThreadFromKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const i = key.lastIndexOf(KEY_SEP);
  return i > 0 ? key.slice(i + KEY_SEP.length) : null;
}

/** True if an OneCLI identifier was minted for a UserCreds per-member agent. */
export function isUserCredsAgentIdentifier(identifier: string | null | undefined): boolean {
  return typeof identifier === 'string' && identifier.startsWith(ID_PREFIX);
}
