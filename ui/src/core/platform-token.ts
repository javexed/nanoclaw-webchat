// ── Platform token refresh ─────────────────────────────────────────────
// Behind Azure App Service EasyAuth, the server verifies the Entra id token
// the platform forwards on every request. EasyAuth stores that token at
// sign-in and keeps forwarding it, unchanged, for the life of the session
// cookie — about an hour of validity inside a session that lasts days. Once
// it expires the server falls back to header trust and says so with
// `X-Webchat-Auth-Hint: token-stale`. The remedy is GET /.auth/refresh, which
// EasyAuth answers itself (it never reaches our server): it renews the token
// store from the refresh token, and the very next request is verified again.
//
// Two things keep this quiet and safe:
//   - It only fires when the server has hinted. An install without EasyAuth
//     never hears the hint, so never makes the call.
//   - A 403/404 means refresh is not available here (no refresh token: the
//     App Service login parameters lack `offline_access`; or no EasyAuth at
//     all). Back off for an hour instead of retrying every request.
// Nothing here can fail the request that triggered it; it is fire-and-forget.

const MIN_INTERVAL_MS = 5 * 60_000;
const UNSUPPORTED_BACKOFF_MS = 60 * 60_000;
const HINT_MEMORY_MS = 60 * 60_000;

let lastAttemptAt = 0;
let unsupportedUntil = 0;
let lastHintAt = 0;
let inFlight: Promise<void> | null = null;

/** Call with every authenticated response; cheap when the header is absent. */
export function noteAuthHint(res: Response): void {
  if (res.headers.get('x-webchat-auth-hint') !== 'token-stale') return;
  lastHintAt = Date.now();
  void refreshPlatformToken();
}

/** On tab resume: if the server hinted recently, refresh before the user acts. */
export function refreshPlatformTokenIfHinted(): void {
  if (Date.now() - lastHintAt < HINT_MEMORY_MS) void refreshPlatformToken();
}

export function refreshPlatformToken(): Promise<void> {
  const now = Date.now();
  if (inFlight) return inFlight;
  if (now < unsupportedUntil || now - lastAttemptAt < MIN_INTERVAL_MS) return Promise.resolve();
  lastAttemptAt = now;
  inFlight = fetch('/.auth/refresh', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => {
      if (r.ok) {
        console.info('[webchat] platform token refreshed');
      } else if (r.status === 403 || r.status === 404) {
        // Not configured for refresh here. Say so once; the fallback is carrying us.
        console.info(`[webchat] /.auth/refresh → ${r.status}; refresh unavailable, backing off 1h`);
        unsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS;
      }
    })
    .catch(() => {
      /* offline or blocked — the next hint will try again after MIN_INTERVAL */
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
