/**
 * Sign-ins: browser sessions started by "Sign in with Microsoft", and explicit
 * links between one person's identities.
 *
 * SESSIONS. A successful Microsoft sign-in (oidc-login.ts) stores the VERIFIED
 * identity it produced — never the linked account it maps to — under the
 * SHA-256 of a random token the browser holds in an HttpOnly cookie. Keeping
 * the raw identity means an unlink applies on the very next request, and the
 * token itself is never at rest: a copy of the database cannot be replayed.
 *
 * LINKS. `alias_user_id → primary_user_id`. A person who signs in by Tailscale
 * on one device and by Microsoft on another is two user ids to the rest of the
 * system (roles, credentials, secrets, paired machines), so auth maps an alias
 * to its primary before anything else sees the id. Links are made only by the
 * person holding both sign-ins at once (see server.ts account routes), and:
 *   - the OLDER identity stays the account; the newer becomes a sign-in for it,
 *     so existing roles and data stay where they are;
 *   - an identity that already holds a role, or already has sign-ins linked to
 *     it, cannot become an alias — its roles would silently stop applying;
 *   - there are no chains: a primary is never itself an alias.
 */
import { createHash, randomBytes } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';

export const SESSION_COOKIE = 'nanoclaw_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface SigninSession {
  userId: string;
  displayName: string;
  expiresAt: number;
}

/** Create a browser session for a verified identity; returns the token for the cookie. */
export async function createSigninSession(userId: string, displayName: string, now = Date.now()): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await getDb().run(
    `INSERT INTO webchat_signin_sessions (token_hash, user_id, display_name, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    hashToken(token),
    userId,
    displayName,
    now,
    now + SESSION_TTL_MS,
    now,
  );
  return token;
}

/** The session behind a cookie token, or null when unknown or expired (an expired row is removed). */
export async function lookupSigninSession(token: string, now = Date.now()): Promise<SigninSession | null> {
  if (!token || !(await hasTable(getDb(), 'webchat_signin_sessions'))) return null;
  const row = (await getDb().get(
    `SELECT user_id, display_name, expires_at, last_used_at FROM webchat_signin_sessions WHERE token_hash = ?`,
    hashToken(token),
  )) as { user_id: string; display_name: string; expires_at: number; last_used_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    await deleteSigninSession(token);
    return null;
  }
  // last_used_at is for the owner's view of active sessions; a minute's
  // resolution keeps it from being a write per request.
  if (now - row.last_used_at > 60_000) {
    await getDb().run(
      `UPDATE webchat_signin_sessions SET last_used_at = ? WHERE token_hash = ?`,
      now,
      hashToken(token),
    );
  }
  return { userId: row.user_id, displayName: row.display_name, expiresAt: row.expires_at };
}

export async function deleteSigninSession(token: string): Promise<void> {
  if (!token) return;
  await getDb().run(`DELETE FROM webchat_signin_sessions WHERE token_hash = ?`, hashToken(token));
}

/** Drop expired sessions; called from the adapter's daily prune. */
export async function pruneSigninSessions(now = Date.now()): Promise<void> {
  if (!(await hasTable(getDb(), 'webchat_signin_sessions'))) return;
  await getDb().run(`DELETE FROM webchat_signin_sessions WHERE expires_at <= ?`, now);
}

/** The cookie token from a request's Cookie header, if any. */
export function sessionTokenFromCookie(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[\w-]{20,200}$/.test(v) ? v : null;
    }
  }
  return null;
}

/**
 * The Set-Cookie value. HttpOnly (no script reads it), SameSite=Lax (not sent
 * on cross-site subrequests or WebSocket upgrades, so another site cannot ride
 * it), Secure whenever the browser reached us over HTTPS.
 */
export function sessionCookie(token: string, secure: boolean, maxAgeMs = SESSION_TTL_MS): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', secure, 0);
}

// ── links ─────────────────────────────────────────────────────────────────────

export interface IdentityLink {
  aliasUserId: string;
  primaryUserId: string;
  createdAt: number;
}

/** The account an identity signs in as: its primary when linked, else itself. */
export async function resolveLinkedUserId(userId: string): Promise<string> {
  try {
    if (!(await hasTable(getDb(), 'webchat_identity_links'))) return userId;
    const row = (await getDb().get(
      `SELECT primary_user_id FROM webchat_identity_links WHERE alias_user_id = ?`,
      userId,
    )) as { primary_user_id: string } | undefined;
    return row?.primary_user_id ?? userId;
  } catch (err) {
    // Unknown is not "someone else": fall back to the identity itself.
    log.warn('Sign-in link lookup failed — using the identity as-is', { userId, err: String(err) });
    return userId;
  }
}

export async function listLinks(primaryUserId: string): Promise<IdentityLink[]> {
  if (!(await hasTable(getDb(), 'webchat_identity_links'))) return [];
  const rows = (await getDb().all(
    `SELECT alias_user_id, primary_user_id, created_at FROM webchat_identity_links WHERE primary_user_id = ? ORDER BY created_at`,
    primaryUserId,
  )) as Array<{ alias_user_id: string; primary_user_id: string; created_at: number }>;
  return rows.map((r) => ({ aliasUserId: r.alias_user_id, primaryUserId: r.primary_user_id, createdAt: r.created_at }));
}

export type LinkRefusal = 'same' | 'has-roles' | 'has-links' | 'already-linked-elsewhere';

async function userCreatedAt(userId: string): Promise<string | null> {
  if (!(await hasTable(getDb(), 'users'))) return null;
  const row = (await getDb().get(`SELECT created_at FROM users WHERE id = ?`, userId)) as
    | { created_at: string }
    | undefined;
  return row?.created_at ?? null;
}

async function holdsRole(userId: string): Promise<boolean> {
  if (!(await hasTable(getDb(), 'user_roles'))) return false;
  return Boolean(await getDb().get(`SELECT 1 FROM user_roles WHERE user_id = ? LIMIT 1`, userId));
}

/**
 * Link two identities one person holds right now. Returns which became the
 * alias, or why it was refused. `a` and `b` are the RAW identities (not
 * already resolved through a link).
 */
export async function linkIdentities(
  a: string,
  b: string,
  now = Date.now(),
): Promise<{ ok: true; primary: string; alias: string } | { ok: false; reason: LinkRefusal }> {
  // Work with the accounts they currently sign in as.
  const pa = await resolveLinkedUserId(a);
  const pb = await resolveLinkedUserId(b);
  if (pa === pb) return { ok: false, reason: 'same' };
  // The identity that is not yet an account-of-record becomes the alias; if
  // both are accounts, the OLDER stays primary so its roles and data stay put.
  const aAliased = pa !== a;
  const bAliased = pb !== b;
  if (aAliased && bAliased) return { ok: false, reason: 'already-linked-elsewhere' };
  let primary: string;
  let alias: string;
  if (aAliased) {
    primary = pa;
    alias = b;
  } else if (bAliased) {
    primary = pb;
    alias = a;
  } else {
    const ca = await userCreatedAt(a);
    const cb = await userCreatedAt(b);
    const aOlder = ca !== null && (cb === null || ca <= cb);
    primary = aOlder ? a : b;
    alias = aOlder ? b : a;
  }
  if ((await listLinks(alias)).length > 0) return { ok: false, reason: 'has-links' };
  if (await holdsRole(alias)) return { ok: false, reason: 'has-roles' };
  await getDb().run(
    `INSERT INTO webchat_identity_links (alias_user_id, primary_user_id, created_at) VALUES (?, ?, ?)`,
    alias,
    primary,
    now,
  );
  return { ok: true, primary, alias };
}

/** Remove a link; only the account it belongs to may (the route checks who is asking). */
export async function unlinkIdentity(primaryUserId: string, aliasUserId: string): Promise<boolean> {
  const r = await getDb().run(
    `DELETE FROM webchat_identity_links WHERE alias_user_id = ? AND primary_user_id = ?`,
    aliasUserId,
    primaryUserId,
  );
  return (r?.changes ?? 0) > 0;
}

/** Plain-language refusal for the UI. */
export function linkRefusalMessage(reason: LinkRefusal, alias?: string): string {
  switch (reason) {
    case 'same':
      return 'These sign-ins already belong to the same account.';
    case 'has-roles':
      return `${alias ?? 'That sign-in'} already has its own roles. Remove them first, or ask an owner to.`;
    case 'has-links':
      return `${alias ?? 'That sign-in'} already has other sign-ins linked to it. Unlink them first.`;
    case 'already-linked-elsewhere':
      return 'Both sign-ins already belong to other accounts.';
  }
}
