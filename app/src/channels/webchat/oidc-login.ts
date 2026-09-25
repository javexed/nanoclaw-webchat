/**
 * The web app's own OIDC sign-in — "Sign in with Microsoft", or with any other
 * OpenID Connect provider (Admin → Sign-in). No App Service or proxy in front.
 *
 * Authorization-code flow with PKCE. The browser goes to the provider, comes
 * back to /auth/oidc/callback with a code; central redeems it at the token
 * endpoint, verifies the id token exactly as it verifies any OIDC token
 * (signature, issuer, audience, expiry) plus the nonce minted for THIS attempt,
 * and starts a session (signins.ts).
 *
 * Settings (auth.ts oidcCfg; read per use):
 *   WEBCHAT_OIDC_ISSUER / _AUDIENCE          required
 *   WEBCHAT_OIDC_AUTHORIZE_URL / _TOKEN_URL  from the provider's discovery
 *                                            (derived for Microsoft)
 *   WEBCHAT_OIDC_CLIENT_SECRET   for a confidential client; omit for a public
 *                                client (PKCE alone)
 *   WEBCHAT_OIDC_TOKEN_AUTH=basic  send the secret as HTTP Basic, for a
 *                                provider that does not take it in the body
 *   WEBCHAT_PUBLIC_URL           the origin users reach central at, when a proxy
 *                                means the request's own Host is not it
 *
 * The redirect URI is <origin>/auth/oidc/callback and must be registered with
 * the provider (Admin → Sign-in shows it). The first version used
 * /auth/microsoft/*; those paths still work. Most providers accept http only
 * for localhost, so a tailnet install needs HTTPS first.
 */
import { createHash, randomBytes } from 'crypto';
import type { IncomingMessage } from 'http';

import { log } from '../../log.js';

import { oidcSettings, verifyOidcTokenDetailed, type OidcIdentity } from './auth.js';

export { oidcLoginEnabled } from './auth.js';

// Read per use, like the rest of the OIDC settings (Admin → Sign-in edits them).
const clientSecret = (): string => (process.env.WEBCHAT_OIDC_CLIENT_SECRET || '').trim();
const publicUrl = (): string => (process.env.WEBCHAT_PUBLIC_URL || '').trim().replace(/\/$/, '');

export const LOGIN_PATH = '/auth/oidc/login';
export const CALLBACK_PATH = '/auth/oidc/callback';
/** The first version's paths, still answered: a registration made then keeps working. */
export const LEGACY_LOGIN_PATH = '/auth/microsoft/login';
export const LEGACY_CALLBACK_PATH = '/auth/microsoft/callback';

/** The origin the browser used: WEBCHAT_PUBLIC_URL, else this request's scheme and Host. */
export function requestOrigin(req: IncomingMessage, tls: boolean): string {
  if (publicUrl()) return publicUrl();
  const host = String(req.headers.host ?? '').trim() || 'localhost';
  const fwd = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim();
  const scheme = tls || fwd === 'https' ? 'https' : 'http';
  return `${scheme}://${host}`;
}

export const isHttpsOrigin = (origin: string): boolean => origin.startsWith('https://');

// ── in-flight attempts ────────────────────────────────────────────────────────

interface Attempt {
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** Linking: the account signed in when the attempt began. */
  linkFrom?: string;
  createdAt: number;
}
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 500;
const attempts = new Map<string, Attempt>();

function sweepAttempts(now: number): void {
  for (const [k, a] of attempts) if (now - a.createdAt > ATTEMPT_TTL_MS) attempts.delete(k);
  while (attempts.size >= MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value!);
}

const b64url = (b: Buffer): string => b.toString('base64url');

/**
 * The attempt is bound to the browser that started it. Without this, someone
 * could start a sign-in with THEIR account, stop at the callback, and send you
 * that link: your browser would finish it and be signed in as them (login
 * CSRF). The callback requires this cookie to name its state. Lax is enough:
 * the provider returns the browser with a top-level GET. Path /auth/ covers
 * the callback under both its current and its legacy path.
 */
export const STATE_COOKIE = 'nanoclaw_signin_state';

export function stateCookie(state: string, secure: boolean, maxAgeS = ATTEMPT_TTL_MS / 1000): string {
  return [
    `${STATE_COOKIE}=${state}`,
    'Path=/auth/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeS)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function stateFromCookie(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  for (const part of (raw ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === STATE_COOKIE) {
      const v = part.slice(i + 1).trim();
      return /^[\w-]{16,100}$/.test(v) ? v : null;
    }
  }
  return null;
}

/** Begin a sign-in: the provider URL to send the browser to. */
export function beginLogin(opts: { redirectUri: string; linkFrom?: string; now?: number }): string {
  const cfg = oidcSettings();
  const now = opts.now ?? Date.now();
  sweepAttempts(now);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  attempts.set(state, { verifier, nonce, redirectUri: opts.redirectUri, linkFrom: opts.linkFrom, createdAt: now });
  const u = new URL(cfg.authorizeUrl);
  // Keep any query the provider's endpoint already carries.
  const q = new URLSearchParams(u.search);
  for (const [k, v] of Object.entries({
    client_id: cfg.audience,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    // When linking, make the provider ask: the browser is probably already
    // signed in there as someone, and that may not be who. Microsoft has an
    // account picker; `login` is the standard prompt every provider knows.
    ...(opts.linkFrom ? { prompt: cfg.provider === 'microsoft' ? 'select_account' : 'login' } : {}),
  }))
    q.set(k, v);
  u.search = q.toString();
  return u.toString();
}

export type LoginResult =
  | { ok: true; identity: OidcIdentity; linkFrom?: string }
  | { ok: false; reason: string; detail?: string };

/**
 * Finish a sign-in: exchange the code, verify the id token and its nonce.
 * `fetchImpl` is injectable for tests. Never logs the code or any token.
 */
export async function completeLogin(
  query: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<LoginResult> {
  const state = query.get('state') ?? '';
  const attempt = attempts.get(state);
  attempts.delete(state); // one use, whatever happens next
  if (query.get('error')) {
    return {
      ok: false,
      reason: 'refused',
      detail: (query.get('error_description') || query.get('error') || '').slice(0, 300),
    };
  }
  if (!attempt || now - attempt.createdAt > ATTEMPT_TTL_MS) return { ok: false, reason: 'expired' };
  const code = query.get('code');
  if (!code) return { ok: false, reason: 'no-code' };

  const cfg = oidcSettings();
  const secret = clientSecret();
  const basic = Boolean(secret) && cfg.tokenAuthBasic;
  const body = new URLSearchParams({
    client_id: cfg.audience,
    grant_type: 'authorization_code',
    code,
    redirect_uri: attempt.redirectUri,
    code_verifier: attempt.verifier,
    ...(secret && !basic ? { client_secret: secret } : {}),
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // RFC 6749 §2.3.1: both halves form-encoded before base64.
  if (basic)
    headers.Authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(cfg.audience)}:${encodeURIComponent(secret)}`,
    ).toString('base64')}`;
  let idToken: string;
  try {
    const res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.id_token) {
      log.warn('OIDC sign-in: token exchange refused', { status: res.status, error: json.error });
      return {
        ok: false,
        reason: 'exchange',
        detail: (json.error_description || json.error || `HTTP ${res.status}`).slice(0, 300),
      };
    }
    idToken = json.id_token;
  } catch (err) {
    log.warn('OIDC sign-in: token endpoint unreachable', { err: String(err) });
    return { ok: false, reason: 'exchange', detail: `the ${cfg.name} token endpoint could not be reached` };
  }
  const verified = await verifyOidcTokenDetailed(idToken, { nonce: attempt.nonce });
  if (!verified.ok) {
    log.warn('OIDC sign-in: id token refused', { reason: verified.reason });
    return { ok: false, reason: 'token', detail: verified.reason };
  }
  return { ok: true, identity: verified.identity, linkFrom: attempt.linkFrom };
}

/** Plain words for the login screen. */
export function loginErrorMessage(reason: string, detail?: string): string {
  const name = oidcSettings().name;
  switch (reason) {
    case 'refused':
      return `${name} did not sign you in${detail ? `: ${detail}` : '.'}`;
    case 'expired':
      return 'That sign-in took too long or was already used. Try again.';
    case 'exchange':
      return `Sign-in could not be completed${detail ? `: ${detail}` : '.'}`;
    case 'token':
      return detail === 'no-identity'
        ? `${name} did not say which verified email you sign in with.`
        : `${name}'s answer could not be verified (${detail ?? 'unknown'}). An admin should check Admin → Sign-in.`;
    default:
      return 'Sign-in failed. Try again.';
  }
}

/** Tests only. */
export function __resetLoginAttemptsForTest(): void {
  attempts.clear();
}
