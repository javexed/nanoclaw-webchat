// ── Per-user action rate limit ───────────────────────────────────────────────
// One debounce shared by every user-credential action (OAuth connect, token
// mint, tool secrets, deploy keys, user/permission routes). The Map is the
// limiter's state, so one module owns it: a copy per importer would limit nothing.

// Cheap in-process guard against UserCreds abuse: a per-identity min-interval on
// credential connects + mint starts (prevents rapid reconnect / spawn churn).
// The host is single-process, so a Map suffices; paired with a global cap on
// concurrent mint containers (MAX_ACTIVE_MINTS) enforced at the start endpoints.
export const userCredsActionAt = new Map<string, number>();

export const USER_CREDS_MIN_INTERVAL_MS = 3000;

export function userCredsRateLimited(userId: string, action: string): boolean {
  const key = `${userId}:${action}`;
  const now = Date.now();
  if (now - (userCredsActionAt.get(key) ?? 0) < USER_CREDS_MIN_INTERVAL_MS) return true;
  userCredsActionAt.set(key, now);
  return false;
}
