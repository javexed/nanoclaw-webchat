/**
 * Who can open a published app. Pure apart from the lookups it is handed, so
 * the rule table is tested without a database.
 *
 *   only-me        the person who exposed it (or approved the agent's card),
 *                  and owners
 *   specific       the people named on the app, by email (Cloudflare only):
 *                  the NanoClaw user signed in with that address
 *   agent-members  whoever may use the agent in NanoClaw (canAccessAgentGroup:
 *                  owners, admins, members)
 *   signed-in      anyone NanoClaw knows as a user
 *
 * Someone NanoClaw does not know is never let in, whatever the rule.
 */
import type { Who } from '../routes.js';

const EMAIL_RE =
  /^[^\s@,;"<>\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A plain email address, lowercased, or null. */
export function normalizeEmail(v: string): string | null {
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/**
 * The email address a NanoClaw user signed in with, when its id is one
 * (`webchat:<email>`: OIDC, Cloudflare Access, an email proxy header). Ids
 * from a Tailscale login or a chat platform name no address.
 */
export function emailOfUser(userId: string): string | null {
  if (!userId.startsWith('webchat:') || userId.startsWith('webchat:tailscale:')) return null;
  return normalizeEmail(userId.slice('webchat:'.length));
}

export interface OpenDeps {
  userExists(userId: string): Promise<boolean>;
  isOwner(userId: string): Promise<boolean>;
  canAccessAgentGroup(userId: string, agentGroupId: string): Promise<boolean>;
}

export type OpenDecision = { ok: true } | { ok: false; reason: 'unknown-user' | 'not-allowed' };

export async function canOpen(
  route: { who: Who; ownerUserId: string | null; agentGroupId: string; emails?: string[] },
  userId: string,
  deps: OpenDeps,
): Promise<OpenDecision> {
  if (!userId || !(await deps.userExists(userId))) return { ok: false, reason: 'unknown-user' };
  switch (route.who) {
    case 'only-me':
      return (route.ownerUserId !== null && userId === route.ownerUserId) || (await deps.isOwner(userId))
        ? { ok: true }
        : { ok: false, reason: 'not-allowed' };
    case 'specific': {
      const email = emailOfUser(userId);
      return email && (route.emails ?? []).includes(email) ? { ok: true } : { ok: false, reason: 'not-allowed' };
    }
    case 'agent-members':
      return (await deps.canAccessAgentGroup(userId, route.agentGroupId))
        ? { ok: true }
        : { ok: false, reason: 'not-allowed' };
    case 'signed-in':
      return { ok: true };
    default:
      return { ok: false, reason: 'not-allowed' };
  }
}
