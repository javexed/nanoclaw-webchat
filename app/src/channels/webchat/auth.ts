/**
 * Webchat HTTP/WS authentication.
 *
 * Auth methods (any combination, controlled by env presence):
 *   - localhost                always passes when remote IP is loopback
 *   - bearer token             WEBCHAT_TOKEN set; matched constant-time
 *   - tailscale whois          IP looked up via `tailscale whois --json`
 *   - trusted-proxy header     WEBCHAT_TRUSTED_PROXY_IPS = "auto" | "*" | csv
 *   - OIDC                     a signed id token from the configured issuer
 *
 * Tailscale, the trusted proxy and OIDC are read from the environment on every
 * use: Admin → Sign-in edits them at runtime (signin-settings.ts writes .env
 * and this process's environment), so a change applies without a restart. The
 * bearer token is fixed at boot.
 *
 * Returns a v2-namespaced user id (`webchat:<...>`) plus a display name.
 * The first identity to authenticate gets auto-granted role='owner' when the
 * permissions module is installed; subsequent identities get no role until
 * granted (so admin endpoints will refuse them unless an owner explicitly
 * promotes them).
 *
 * If permissions isn't installed, authenticated callers are implicitly fully
 * privileged (the v2 command-gate degrades to allow-all without `user_roles`).
 */
import { type IncomingMessage } from 'http';
import { execFile } from 'child_process';
import {
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey as CryptoJsonWebKey,
  type KeyObject,
} from 'crypto';

import { audit } from '../../audit.js';
import { hasTable, getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { getBearerTokenDisabled, getPromoteFirstTailscaleOwner, setPromoteFirstTailscaleOwner } from './db.js';
import { ensureOwnerRoleOnFirstLogin, grantOwnerRole, isOwner } from './roles.js';
import { lookupSigninSession, resolveLinkedUserId, sessionTokenFromCookie } from './signins.js';

const WEBCHAT_TOKEN = process.env.WEBCHAT_TOKEN || '';
const tailscaleEnabled = (): boolean => process.env.WEBCHAT_TAILSCALE === 'true';
export const DEFAULT_PROXY_HEADER = 'x-forwarded-user';
// Bind host (see channels/webchat/index.ts — default 127.0.0.1). A loopback
// bind means the server is reachable only from this machine, so the localhost
// auto-owner is the whole security story: no token, no network exposure.
const WEBCHAT_HOST = (process.env.WEBCHAT_HOST || '127.0.0.1').trim();

/** Is the server bound to a loopback interface (single-machine reach)? */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '' || h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/**
 * Trusted proxy modes. The mode selects the IP GATE only — every mode reads
 * the same headers (platform pairs first, then TRUSTED_PROXY_HEADER), so
 * tightening the gate never changes which proxies can be understood.
 *
 *   "auto" / "*"  — no IP gate. Identity is taken from whichever platform
 *                   header pair is present (Azure EasyAuth, Cloudflare
 *                   Access), else from TRUSTED_PROXY_HEADER. Headers are NOT
 *                   cryptographically verified — the EasyAuth blob is unsigned
 *                   base64 JSON the platform injects — so this is safe ONLY if
 *                   the server is reachable EXCLUSIVELY through the proxy.
 *                   A loopback bind, or a firewall, has to make that true.
 *   IP/CIDR list  — the hop must match (recommended). Same headers, but a
 *                   direct :PORT hit from any other address is refused before
 *                   any header is read.
 */
function proxyCfg(): { raw: string; header: string; trustAny: boolean; entries: string[] } {
  const raw = (process.env.WEBCHAT_TRUSTED_PROXY_IPS || '').trim();
  const trustAny = raw === 'auto' || raw === '*';
  return {
    raw,
    header: (process.env.WEBCHAT_TRUSTED_PROXY_HEADER || DEFAULT_PROXY_HEADER).trim().toLowerCase(),
    trustAny,
    entries: trustAny
      ? []
      : raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
  };
}
const proxyEnabled = (): boolean => proxyCfg().raw.length > 0;

const PLATFORM_HEADERS: Array<{ identity: string; verify: string; name: string }> = [
  // Azure App Service EasyAuth — x-ms-client-principal is a signed blob the platform injects.
  { identity: 'x-ms-client-principal-name', verify: 'x-ms-client-principal', name: 'Azure EasyAuth' },
  // Cloudflare Access — Cf-Access-Jwt-Assertion accompanies the email header.
  { identity: 'cf-access-authenticated-user-email', verify: 'cf-access-jwt-assertion', name: 'Cloudflare Access' },
];

/**
 * OIDC: a signed id token from the configured issuer — Microsoft Entra ID or any
 * other OpenID Connect provider (Okta, Google, Keycloak, Authentik …).
 *
 * Tokens arrive three ways: the web app's own sign-in (oidc-login.ts), a
 * Bearer from a non-browser client (the VS Code extension), and App Service
 * EasyAuth's x-ms-token-aad-id-token. Verifying the token is strictly better
 * than trusting EasyAuth's sibling x-ms-client-principal-name header: that is
 * unsigned base64, protected only by network position.
 *
 * Settings (signin-settings.ts writes them; read on every use):
 *   WEBCHAT_OIDC_PROVIDER       microsoft | other (default: microsoft when the
 *                               issuer is login.microsoftonline.com)
 *   WEBCHAT_OIDC_NAME           the provider's name on the login button (other)
 *   WEBCHAT_OIDC_ISSUER         exactly the `iss` its tokens carry
 *   WEBCHAT_OIDC_AUDIENCE       the client id
 *   WEBCHAT_OIDC_JWKS_URI       signing keys (from discovery; derived for Microsoft)
 *   WEBCHAT_OIDC_AUTHORIZE_URL  / WEBCHAT_OIDC_TOKEN_URL   the sign-in flow's
 *                               endpoints (from discovery; derived for Microsoft)
 *
 * No dependency: node:crypto verifies RS256 and ES256 straight from a JWK.
 */
const MS_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/;

export type OidcProvider = 'microsoft' | 'other';

export interface OidcConfig {
  provider: OidcProvider;
  name: string;
  issuer: string;
  audience: string;
  jwksUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** client_secret_basic instead of client_secret_post at the token endpoint. */
  tokenAuthBasic: boolean;
  enabled: boolean;
  loginFlag: string;
}

export function oidcCfg(env: NodeJS.ProcessEnv = process.env): OidcConfig {
  const v = (k: string) => (env[k] || '').trim();
  const issuer = v('WEBCHAT_OIDC_ISSUER');
  const audience = v('WEBCHAT_OIDC_AUDIENCE');
  const ms = MS_ISSUER.test(issuer);
  const provider: OidcProvider =
    v('WEBCHAT_OIDC_PROVIDER') === 'other'
      ? 'other'
      : v('WEBCHAT_OIDC_PROVIDER') === 'microsoft' || ms
        ? 'microsoft'
        : 'other';
  // Microsoft's endpoints follow from the issuer; installs set up before discovery
  // was stored have only the issuer, and keep working.
  const msBase = ms ? issuer.replace(/\/v2\.0\/?$/, '') : '';
  const jwksUri = v('WEBCHAT_OIDC_JWKS_URI') || (ms ? `${msBase}/discovery/v2.0/keys` : '');
  return {
    provider,
    name: provider === 'microsoft' ? 'Microsoft' : v('WEBCHAT_OIDC_NAME') || 'SSO',
    issuer,
    audience,
    jwksUri,
    authorizeUrl: v('WEBCHAT_OIDC_AUTHORIZE_URL') || (ms ? `${msBase}/oauth2/v2.0/authorize` : ''),
    tokenUrl: v('WEBCHAT_OIDC_TOKEN_URL') || (ms ? `${msBase}/oauth2/v2.0/token` : ''),
    tokenAuthBasic: v('WEBCHAT_OIDC_TOKEN_AUTH') === 'basic',
    enabled: Boolean(issuer && audience && jwksUri),
    loginFlag: v('WEBCHAT_OIDC_LOGIN').toLowerCase(),
  };
}

/** The OIDC settings, for the sign-in flow (oidc-login.ts). */
export function oidcSettings(): OidcConfig {
  return oidcCfg();
}

/** The web app's own sign-in button: OIDC with a sign-in flow, unless WEBCHAT_OIDC_LOGIN=false. */
export function oidcLoginEnabled(): boolean {
  const c = oidcCfg();
  return c.enabled && Boolean(c.authorizeUrl && c.tokenUrl) && c.loginFlag !== 'false';
}

const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
// Id tokens live ~1h; allow for modest clock drift either way.
const CLOCK_SKEW_S = 120;
const JWKS_TTL_MS = 3_600_000;
// Every fetch — TTL refresh or unknown-kid refetch — is rate-limited on the last
// ATTEMPT, not the last success. Keying on success (the first cut did) meant a
// JWKS outage reset nothing, so each request retried immediately: exactly the
// outbound storm the limit exists to prevent. On an attempt-based gate an
// outage costs one request per window, and a stream of forged kids the same.
// Rotation still lands within one window without a restart.
const JWKS_MIN_REFETCH_MS = 60_000;

/** A signing key and the one algorithm it may verify: a token's `alg` must match its key. */
interface SigningKey {
  key: KeyObject;
  alg: 'RS256' | 'ES256';
}
let jwksKeys: Map<string, SigningKey> | null = null;
/** The key set's source. A different tenant means different keys: never serve the old set for it. */
let jwksUriLoaded = '';
let jwksFetchedAt = 0; // last SUCCESS — drives TTL staleness; stale keys keep serving through an outage
let jwksLastAttemptAt = 0; // last ATTEMPT — drives the rate limit
let jwksInFlight: Promise<void> | null = null;

async function fetchJwks(): Promise<void> {
  if (jwksInFlight) return jwksInFlight;
  jwksLastAttemptAt = Date.now();
  const uri = oidcCfg().jwksUri;
  jwksInFlight = (async () => {
    try {
      const res = await fetch(uri, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
      const next = new Map<string, SigningKey>();
      for (const jwk of body.keys ?? []) {
        const kid = typeof jwk.kid === 'string' ? jwk.kid : null;
        if (!kid || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
        const alg = jwk.kty === 'RSA' ? 'RS256' : jwk.kty === 'EC' && jwk.crv === 'P-256' ? 'ES256' : null;
        if (!alg) continue;
        try {
          next.set(kid, { key: createPublicKey({ key: jwk as unknown as CryptoJsonWebKey, format: 'jwk' }), alg });
        } catch {
          /* a key we cannot import is not a reason to drop the rest */
        }
      }
      if (next.size > 0) {
        jwksKeys = next;
        jwksUriLoaded = uri;
        jwksFetchedAt = Date.now();
        log.info('Webchat OIDC: JWKS loaded', { keys: next.size });
      }
    } catch (err) {
      log.warn('Webchat OIDC: JWKS fetch failed', { err, uri });
    } finally {
      jwksInFlight = null;
    }
  })();
  return jwksInFlight;
}

async function jwksKey(kid: string): Promise<SigningKey | null> {
  // Settings changed the tenant: the cached keys belong to the old one.
  if (jwksKeys && jwksUriLoaded !== oidcCfg().jwksUri) {
    jwksKeys = null;
    jwksLastAttemptAt = 0;
  }
  const mayFetch = (): boolean => Date.now() - jwksLastAttemptAt > JWKS_MIN_REFETCH_MS;
  const stale = !jwksKeys || Date.now() - jwksFetchedAt > JWKS_TTL_MS;
  if (stale && mayFetch()) await fetchJwks();
  const hit = jwksKeys?.get(kid);
  if (hit) return hit;
  // Unknown kid — the provider rotated, or a forgery. One refetch if the window allows;
  // a refresh that just ran (and missed) has closed it, so this is never two
  // outbound calls for one request.
  if (mayFetch()) {
    await fetchJwks();
    return jwksKeys?.get(kid) ?? null;
  }
  return null;
}

export interface OidcIdentity {
  identity: string;
  displayName: string;
}

/**
 * Why a token was refused. Logged on fall-through so a stale EasyAuth token
 * store ("expired", days) reads differently from a rotated signing key
 * ("unknown-kid") or a misconfigured registration ("audience"/"issuer").
 * Never accompanied by the token or its claims — only the verdict, and for an
 * expiry, how long ago.
 */
export type OidcFailure =
  | 'disabled'
  | 'malformed'
  | 'alg'
  | 'unknown-kid'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'issuer'
  | 'audience'
  | 'nonce'
  | 'no-identity';

export type OidcResult =
  | { ok: true; identity: OidcIdentity }
  | { ok: false; reason: OidcFailure; expiredForS?: number };

/**
 * Verify signature + iss/aud/exp/nbf, and say WHY when it fails. `nonce`, when
 * given, must match the token's own: the sign-in flow mints one per attempt, so
 * an id token issued for some other attempt cannot be replayed into this one.
 */
export async function verifyOidcTokenDetailed(token: string, opts: { nonce?: string } = {}): Promise<OidcResult> {
  const cfg = oidcCfg();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!JWT_SHAPE.test(token)) return { ok: false, reason: 'malformed' };
  const [h, p, sig] = token.split('.');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>;
    claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Pin the algorithm. Honouring whatever `alg` says is the classic JWT hole:
  // 'none' skips verification entirely, and HS256 lets an attacker sign with
  // the PUBLIC key as the HMAC secret. RS256 or ES256 only, and only with a key
  // of that type.
  if ((header.alg !== 'RS256' && header.alg !== 'ES256') || typeof header.kid !== 'string')
    return { ok: false, reason: 'alg' };
  const key = await jwksKey(header.kid);
  if (!key) return { ok: false, reason: 'unknown-kid' };
  if (key.alg !== header.alg) return { ok: false, reason: 'alg' };
  const signed = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(sig, 'base64url');
  const good =
    key.alg === 'RS256'
      ? verifySignature('sha256', signed, key.key, signature)
      : verifySignature('sha256', signed, { key: key.key, dsaEncoding: 'ieee-p1363' }, signature);
  if (!good) return { ok: false, reason: 'bad-signature' };

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now - CLOCK_SKEW_S) {
    return { ok: false, reason: 'expired', expiredForS: typeof claims.exp === 'number' ? now - claims.exp : undefined };
  }
  if (typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW_S) return { ok: false, reason: 'not-yet-valid' };
  if (claims.iss !== cfg.issuer) return { ok: false, reason: 'issuer' };
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(cfg.audience) : aud === cfg.audience;
  if (!audOk) return { ok: false, reason: 'audience' };
  if (opts.nonce !== undefined && claims.nonce !== opts.nonce) return { ok: false, reason: 'nonce' };

  const identity = oidcIdentityClaim(cfg.provider, claims);
  if (!identity) return { ok: false, reason: 'no-identity' };
  const name = typeof claims.name === 'string' && claims.name ? claims.name : identity;
  return { ok: true, identity: { identity, displayName: name } };
}

/**
 * Who the token names. Entra: its sign-in name (preferred_username, upn), as
 * before. Any other provider: the email, and only when the provider says it is
 * verified — preferred_username there is often a free-form, user-chosen handle,
 * and an unverified email is anyone's to claim. Ids are webchat:<email>, the
 * same shape a trusted proxy's email header produces, so one person is one user.
 */
export function oidcIdentityClaim(provider: OidcProvider, claims: Record<string, unknown>): string | null {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  if (provider === 'microsoft') return str(claims.preferred_username) ?? str(claims.upn) ?? str(claims.email);
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  return verified ? str(claims.email) : null;
}

/** Verify signature + iss/aud/exp/nbf. Returns null on ANY failure. */
export async function verifyOidcToken(token: string): Promise<OidcIdentity | null> {
  const r = await verifyOidcTokenDetailed(token);
  return r.ok ? r.identity : null;
}

// A stale token is re-sent on EVERY request — one page load produced ~45
// identical warnings in five seconds. One line per (source ip, reason) per
// minute, carrying the count it swallowed, keeps the signal and drops the flood.
const OIDC_WARN_WINDOW_MS = 60_000;
const oidcWarnState = new Map<string, { at: number; suppressed: number }>();
function warnOidcFallThrough(remoteIp: string, r: Extract<OidcResult, { ok: false }>): void {
  const key = `${remoteIp}|${r.reason}`;
  const now = Date.now();
  const prev = oidcWarnState.get(key);
  if (prev && now - prev.at < OIDC_WARN_WINDOW_MS) {
    prev.suppressed += 1;
    return;
  }
  if (oidcWarnState.size > 1000) oidcWarnState.clear();
  log.warn('Webchat OIDC: token present but not verifiable — falling through', {
    remoteIp,
    reason: r.reason,
    ...(r.expiredForS !== undefined ? { expiredForS: r.expiredForS } : {}),
    suppressedRepeats: prev?.suppressed ?? 0,
  });
  oidcWarnState.set(key, { at: now, suppressed: 0 });
}

export interface AuthResult {
  ok: true;
  userId: string;
  displayName: string;
  source: 'localhost' | 'bearer' | 'tailscale' | 'proxy-header' | 'oidc';
  /**
   * The identity that actually signed in, when a link maps it to a different
   * account (signins.ts). userId is the account; this is the sign-in.
   */
  signedInAs?: string;
  /** The request carried a "Sign in with Microsoft" session cookie that authenticated it. */
  viaSession?: boolean;
  /**
   * Set when a signed token WAS presented but had expired, and a weaker method
   * carried the request instead. EasyAuth keeps forwarding the id token it
   * stored at sign-in for the life of the session cookie, so an hour after
   * sign-in every request arrives with a dead token and silently degrades to
   * header trust. The HTTP layer surfaces this as `X-Webchat-Auth-Hint:
   * token-stale` so the client can call /.auth/refresh and get back onto the
   * verified path. Never a refusal — availability is the fallback's job.
   */
  hint?: 'token-stale';
}

export interface AuthFailure {
  ok: false;
  reason: string;
}

/**
 * Auth events, deduplicated. authenticateRequest runs on EVERY HTTP request
 * and WS upgrade, so raw emission would write a line per API call and turn
 * the audit log into an access log. What an incident review needs is
 * TRANSITIONS: the first time an identity shows up over a given source+ip
 * since boot, and refusals. The concrete case this must answer: "which
 * identity consumed the fresh-install owner grant, and from where?" — a
 * question that was unanswerable when exactly that happened.
 */
const auditedSessions = new Set<string>();
const auditedDenials = new Map<string, number>();

export async function authenticateRequest(req: IncomingMessage): Promise<AuthResult | AuthFailure> {
  const result = await authenticate(req);
  const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
  if (result.ok) {
    const key = `${result.userId}|${result.source}|${remoteIp}`;
    if (!auditedSessions.has(key)) {
      auditedSessions.add(key);
      audit({
        type: 'auth.session',
        actor: `human:${result.userId}`,
        effect: 'allow',
        detail: { source: result.source, ip: remoteIp },
      });
    }
  } else {
    // Refusals are the interesting half, but a scanner hammering an exposed
    // port must not be able to grow the file unboundedly — one line per ip
    // per minute is enough to see the attempt and its persistence.
    const last = auditedDenials.get(remoteIp) ?? 0;
    if (Date.now() - last > 60_000) {
      auditedDenials.set(remoteIp, Date.now());
      audit({ type: 'auth.denied', effect: 'deny', detail: { ip: remoteIp } });
    }
  }
  return result;
}

async function authenticate(req: IncomingMessage): Promise<AuthResult | AuthFailure> {
  const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
  // Carried from the OIDC branch onto whatever weaker method authenticates
  // afterwards — see AuthResult.hint.
  let hint: AuthResult['hint'];
  const withHint = (r: AuthResult): AuthResult => (hint ? { ...r, hint } : r);

  // 1. Bearer token from Authorization header or WebSocket subprotocol.
  //    PWA passes via `Sec-WebSocket-Protocol: bearer.<token>` so the secret
  //    stays out of URLs (and therefore out of proxy access logs).
  const providedToken = extractBearer(req);
  if ((await bearerActive()) && providedToken && safeEqual(providedToken, WEBCHAT_TOKEN)) {
    return finalize({ source: 'bearer', userId: 'webchat:owner', displayName: 'operator' });
  }

  // 1b. OIDC — a signed id token, verified against the issuer's JWKS.
  //     Ordered ahead of the proxy header deliberately: this is the only
  //     branch that proves WHO the caller is rather than where they are.
  //
  //     Two sources. EasyAuth forwards the browser's id token in
  //     x-ms-token-aad-id-token when its token store is on; a non-browser
  //     client (a runner daemon, an extension) would present its own token as
  //     a Bearer. Same verification either way.
  //
  //     A token that fails verification FALLS THROUGH rather than refusing.
  //     EasyAuth's stored id token can lapse between refreshes, and a browser
  //     that the platform already authenticated must not be locked out by our
  //     stricter check. Falling through costs nothing: the branch below is
  //     IP-gated to the proxy, so the fallback is exactly today's posture, and
  //     a forged token cannot manufacture reach it does not already have.
  if (oidcCfg().enabled) {
    const rawId = req.headers['x-ms-token-aad-id-token'];
    const headerToken = Array.isArray(rawId) ? rawId[0] : rawId;
    const presented = providedToken && JWT_SHAPE.test(providedToken) ? providedToken : headerToken;
    if (typeof presented === 'string' && presented) {
      const result = await verifyOidcTokenDetailed(presented);
      if (result.ok) {
        return finalize({
          source: 'oidc',
          userId: `webchat:${normalizeId(result.identity.identity)}`,
          displayName: result.identity.displayName,
        });
      }
      warnOidcFallThrough(remoteIp, result);
      if (result.reason === 'expired') hint = 'token-stale';
    }
  }

  // 1c. A browser session started by the web app's OIDC sign-in (oidc-login.ts),
  //     carried in an HttpOnly, SameSite=Lax cookie. Honoured only while OIDC
  //     is configured, so turning it off ends every session. A
  //     WebSocket upgrade must come from this same origin: Lax already keeps the
  //     cookie off cross-site upgrades, and checking Origin does not rely on
  //     every browser agreeing about that.
  const sessionToken = oidcCfg().enabled ? sessionTokenFromCookie(req.headers.cookie) : null;
  if (sessionToken && !(req.headers.upgrade && !sameOriginRequest(req))) {
    const session = await lookupSigninSession(sessionToken).catch(() => null);
    if (session) {
      const r = await finalize({ source: 'oidc', userId: session.userId, displayName: session.displayName });
      return withHint({ ...r, viaSession: true });
    }
  }

  // 2. Trusted proxy header — proxy is the auth authority.
  const proxy = authenticateTrustedProxy(req, remoteIp);
  if (proxy) {
    return withHint(
      await finalize({
        source: 'proxy-header',
        userId: `webchat:${normalizeId(proxy.identity)}`,
        displayName: proxy.identity,
      }),
    );
  }

  // 3. Tailscale identity.
  if (tailscaleEnabled()) {
    // 3a. Tailscale Serve (HTTPS front). `tailscale serve` terminates TLS on
    //     the *.ts.net name and forwards to loopback, injecting
    //     Tailscale-User-Login. Honor it ONLY from a loopback source — serve is
    //     always localhost→localhost, so the same header from any other IP is a
    //     forgery (a direct :PORT hit impersonating a tailnet user) and is
    //     ignored. Minting the SAME `webchat:tailscale:<login>` id that whois
    //     produces keeps identity continuous across the http-tailnet → https-
    //     serve switch, so an owner claimed over http stays owner over https.
    const serveLogin = tailscaleServeIdentity(req, remoteIp);
    if (serveLogin) {
      return withHint(
        await finalize({
          source: 'tailscale',
          userId: `webchat:tailscale:${normalizeId(serveLogin)}`,
          displayName: serveLogin,
        }),
      );
    }
    // 3b. Direct tailnet connection — whois the peer's tailnet IP.
    const tsUser = await tailscaleWhois(remoteIp);
    if (tsUser) {
      return finalize({
        source: 'tailscale',
        userId: `webchat:tailscale:${normalizeId(tsUser)}`,
        displayName: tsUser,
      });
    }
  }

  // 4. Localhost auto-pass — last resort, ONLY when no explicit auth method
  //    is configured. If the operator has set up bearer / tailscale / proxy
  //    auth, we must NOT trust loopback unconditionally: a fronting reverse
  //    proxy (Tailscale Serve, nginx, Caddy, oauth2-proxy, ...) terminates
  //    the public hostname and forwards to 127.0.0.1, so unauthenticated
  //    tailnet/internet traffic would otherwise bypass auth and be granted
  //    owner. With explicit auth configured, the proxy must surface the
  //    upstream identity via headers / token / tailscale whois.
  if (isLocalhost(remoteIp) && !(await hasExplicitAuth())) {
    const localUser = process.env.USER || process.env.USERNAME || 'user';
    return finalize({ source: 'localhost', userId: 'webchat:local-owner', displayName: localUser });
  }

  return { ok: false, reason: 'Unauthorized' };
}

/** True when the configured network mode requires at least one explicit auth method. */
export function requiresExplicitAuth(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

/**
 * Whether the bearer token is currently a usable auth method: configured AND not
 * retired by the owner. Once an alternative method (Tailscale/SSO) is live the
 * owner can disable the bearer token from Settings — auth.ts then ignores
 * WEBCHAT_TOKEN even though its value still sits in .env (see the bearer_token_
 * disabled flag / moduleWebchatBearerAuth).
 */
async function bearerActive(): Promise<boolean> {
  // The disabled flag lives in the DB now. `!getBearerTokenDisabled()` on the
  // un-awaited promise was always false — the bearer token reported INACTIVE
  // forever, and canDisableBearer with it.
  return Boolean(WEBCHAT_TOKEN) && !(await getBearerTokenDisabled());
}

export type SigninMethod = 'token' | 'tailscale' | 'proxy' | 'oidc';

/** Which methods can sign someone in right now (Tailscale only while its daemon is up). */
export async function usableMethods(): Promise<Record<SigninMethod, boolean>> {
  return {
    token: await bearerActive(),
    tailscale: tailscaleEnabled() && tailscaleHealthy === true,
    proxy: proxyEnabled(),
    oidc: oidcCfg().enabled,
  };
}

/** The method a request authenticated through; null for the localhost owner. */
export function methodOfSource(source: AuthResult['source']): SigninMethod | null {
  return source === 'bearer'
    ? 'token'
    : source === 'proxy-header'
      ? 'proxy'
      : source === 'tailscale' || source === 'oidc'
        ? source
        : null;
}

/** True when at least one non-localhost auth method is currently usable. */
export async function hasExplicitAuth(): Promise<boolean> {
  // OIDC counts: configuring it alone is a complete auth method, and omitting
  // it here would leave the loopback auto-pass armed on an OIDC-only install.
  return (await bearerActive()) || tailscaleEnabled() || proxyEnabled() || oidcCfg().enabled;
}

// ── Tailscale health probe ──
// The login screen needs to tell the user *why* their request was rejected.
// We probe `tailscale status --json` — it succeeds only when the binary is on
// PATH AND the local daemon is logged into a tailnet, so a flipped flag
// captures both "not installed" and "tailscaled down / logged out" without
// needing two probes.
//
// The result is NOT cached for the process lifetime: the very deployments this
// serves (the Proxmox / community-script install) enable Tailscale auth up
// front and add Tailscale *later*, so a boot probe legitimately starts false
// and must be able to flip true without a restart. Reads re-probe in the
// background when the cached value is stale (see refreshTailscaleHealth), so
// "not detected" self-heals within a poll cycle once tailscale comes up — and
// flips back if tailscaled later goes down. A snap-packaged `tailscale` (the
// Ubuntu default) can be slow to cold-start, so the timeout is generous; the
// probe never blocks a request, it only refreshes the cached flag.
//
// State:
//   null  → not probed yet (probe runs during startWebchatServer)
//   true  → `tailscale status` succeeded → server can do whois
//   false → ENOENT, non-zero exit, or timeout → log already emitted
//
// Note: this only checks the SERVER. A healthy server can still 401 a
// client if Tailscale isn't running on the client device — the most common
// failure pattern. The PWA's login copy reflects that.
let tailscaleHealthy: boolean | null = null;
let tailscaleProbedAt = 0;
let tailscaleProbeInFlight: Promise<void> | null = null;
// Re-probe cadence: eager while we haven't seen tailscale yet (the "added
// later" case, where the operator is waiting for it to register), lazier once
// it's up (a keepalive that also catches tailscaled going away).
const TS_PROBE_INTERVAL_DOWN_MS = 10_000;
const TS_PROBE_INTERVAL_UP_MS = 60_000;

/** Outcome of one `tailscale status` attempt. Injectable so the state machine
 *  around it is unit-testable without a real daemon (mirrors tailscale-serve). */
export interface TailscaleProbeResult {
  ok: boolean;
  /** binary absent (ENOENT) — the expected "added later" case, not a fault. */
  notInstalled: boolean;
}
export type TailscaleProbeRunner = () => Promise<TailscaleProbeResult>;

const defaultProbeRunner: TailscaleProbeRunner = () =>
  new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 5000 }, (err) => {
      resolve({ ok: !err, notInstalled: !!err && (err as NodeJS.ErrnoException).code === 'ENOENT' });
    });
  });

/**
 * Is a re-probe due? Pure so the cadence logic is tested without timers or a
 * daemon: eager interval while down/unknown, lazy interval once up.
 */
export function tailscaleReprobeDue(healthy: boolean | null, probedAt: number, now: number): boolean {
  const interval = healthy === true ? TS_PROBE_INTERVAL_UP_MS : TS_PROBE_INTERVAL_DOWN_MS;
  return now - probedAt >= interval;
}

export async function probeTailscaleHealth(run: TailscaleProbeRunner = defaultProbeRunner): Promise<void> {
  // Probe UNCONDITIONALLY. `tailscaleHealthy` is a host-presence fact — is a
  // tailnet-joined daemon up on this box? — which the wizard needs in order to
  // OFFER tailnet auth. Whether tailscale is actually USED for auth is a
  // separate decision (TAILSCALE_ENABLED, applied downstream). Gating the probe
  // on the enable flag was a chicken-and-egg: the probe only ran once you'd
  // already turned on the very thing the probe exists to help you turn on, so
  // the wizard's Tailscale step could never see a running tailnet.
  // Collapse concurrent callers onto one in-flight probe.
  if (tailscaleProbeInFlight) return tailscaleProbeInFlight;
  const wasHealthy = tailscaleHealthy;
  tailscaleProbeInFlight = (async () => {
    const { ok, notInstalled } = await run();
    if (!ok) {
      // Log only on a state change AND only when tailscale is the configured
      // auth method — a localhost/bearer install shouldn't warn just because it
      // has no tailscale. Detection still records the false either way.
      if (wasHealthy !== false && tailscaleEnabled()) {
        if (notInstalled) {
          // Not an error: deployments (e.g. the Proxmox install) enable Tailscale
          // auth up front so the tailnet flow needs no config, and add Tailscale
          // later. Until then tailscale-auth simply doesn't apply and other
          // methods (bearer / proxy) carry access.
          log.info(
            'Webchat: WEBCHAT_TAILSCALE=true but `tailscale` is not installed yet — ' +
              'tailnet sign-in becomes available once you add Tailscale; bearer/proxy auth works meanwhile.',
          );
        } else {
          log.warn('Webchat: `tailscale status` probe failed — tailscaled may not be running or logged in');
        }
      }
      tailscaleHealthy = false;
    } else {
      if (wasHealthy !== true) log.info('Webchat: tailscale detected on host');
      tailscaleHealthy = true;
    }
    tailscaleProbedAt = Date.now();
    tailscaleProbeInFlight = null;
  })();
  return tailscaleProbeInFlight;
}

/**
 * Fire a background re-probe if the cached health is stale, so the coarse flag
 * the login screen / wizard reads tracks reality without a restart. Non-blocking
 * by design: the current read returns the cached value and the refreshed one
 * lands for the next poll — the UI already polls these endpoints. No-op when
 * Tailscale auth isn't enabled or a probe is already running.
 */
export function refreshTailscaleHealth(): void {
  // Runs regardless of TAILSCALE_ENABLED so host-presence detection works during
  // setup (see probeTailscaleHealth). Still lazy: only when a read makes it due.
  if (tailscaleProbeInFlight) return;
  if (!tailscaleReprobeDue(tailscaleHealthy, tailscaleProbedAt, Date.now())) return;
  void probeTailscaleHealth();
}

/**
 * Non-sensitive auth info for the PWA's login screen so it can tailor the
 * message ("enter your token" vs "Tailscale on this device" vs "ask whoever
 * set this up"). Exposes which methods are configured and a coarse health
 * flag for tailscale on the server. Does NOT reveal tokens, IPs, or details
 * about the failure reason — that goes to the server log only.
 *
 * Safe to expose pre-auth: anyone hitting the URL can already infer which
 * methods exist from the deployment shape (tailnet hostname, presence of a
 * fronting proxy, etc.).
 */
export async function getAuthInfo(): Promise<{
  methods: { bearer: boolean; tailscale: boolean; proxy: boolean; oidc: boolean; oidcLogin: boolean };
  /** The provider's name, for the login button ("Sign in with Okta"). */
  oidcName: string;
  tailscaleHealthy: boolean;
}> {
  refreshTailscaleHealth(); // background re-probe if stale; returns cached value now
  const oidc = oidcCfg();
  return {
    methods: {
      bearer: await bearerActive(),
      tailscale: tailscaleEnabled(),
      proxy: proxyEnabled(),
      oidc: oidc.enabled,
      oidcLogin: oidcLoginEnabled(),
    },
    oidcName: oidc.name,
    // Pre-auth login hint: only advertise tailscale health when it's actually an
    // enabled auth method here. Raw host-presence (probe result) is exposed to
    // the owner via getAuthManagementInfo, not to unauthenticated callers.
    tailscaleHealthy: tailscaleEnabled() && tailscaleHealthy === true,
  };
}

/**
 * Owner-only auth-management view for Settings: which methods exist, whether the
 * bearer token is currently honored, and whether it's safe to retire it. The
 * bearer token may only be disabled when an alternative method is actually
 * usable (Tailscale up, or a trusted-proxy/SSO method configured) so turning it
 * off can never lock everyone out. Unlike getAuthInfo this is gated behind auth.
 */
export async function getAuthManagementInfo(): Promise<{
  bearerConfigured: boolean;
  bearerActive: boolean;
  tailscale: { enabled: boolean; healthy: boolean };
  proxy: boolean;
  /** Id tokens from the configured OIDC issuer are verified here. */
  oidc: boolean;
  loopback: boolean;
  hasAlternativeAuth: boolean;
  canDisableBearer: boolean;
  canEnableBearer: boolean;
}> {
  refreshTailscaleHealth(); // background re-probe if stale; returns cached value now
  const proxy = proxyEnabled();
  const tailscaleUsable = tailscaleEnabled() && tailscaleHealthy === true;
  // A verified OIDC token is a complete method on its own (see hasExplicitAuth).
  const hasAlternativeAuth = tailscaleUsable || proxy || oidcCfg().enabled;
  const active = await bearerActive();
  return {
    bearerConfigured: Boolean(WEBCHAT_TOKEN),
    bearerActive: active,
    tailscale: { enabled: tailscaleEnabled(), healthy: tailscaleHealthy === true },
    proxy,
    oidc: oidcCfg().enabled,
    // Bound to loopback → "Localhost only" mode: single-machine, auto-owner.
    loopback: isLoopbackHost(WEBCHAT_HOST),
    hasAlternativeAuth,
    // Can retire the token only while it's live AND something else can auth.
    canDisableBearer: active && hasAlternativeAuth,
    // Can bring it back whenever it's configured but currently inert.
    canEnableBearer: Boolean(WEBCHAT_TOKEN) && !active,
  };
}

/**
 * Minimum bearer-token length. Operators sometimes pick a short or memorable
 * value; combined with no rate-limiting (deferred to an upstream module),
 * that's brute-forceable. 24 chars matches the entropy of a base64-encoded
 * 16-byte secret, the floor for an "actually random" token.
 */
const MIN_BEARER_TOKEN_LENGTH = 24;

/**
 * Refuse to start with a too-short bearer token. Called from the server boot
 * gate so misconfigurations fail loudly rather than silently weakening auth.
 */
export function assertBearerTokenStrength(): void {
  if (WEBCHAT_TOKEN && WEBCHAT_TOKEN.length < MIN_BEARER_TOKEN_LENGTH) {
    throw new Error(
      `Webchat refusing to start: WEBCHAT_TOKEN is ${WEBCHAT_TOKEN.length} chars, ` +
        `must be at least ${MIN_BEARER_TOKEN_LENGTH}. Generate one with: ` +
        `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`,
    );
  }
}

/**
 * The request came through the configured trusted proxy. Its Host is the
 * proxy's own public name, and the proxy is where identity is decided.
 */
export function viaTrustedProxy(req: IncomingMessage): boolean {
  const cfg = proxyCfg();
  if (!cfg.raw) return false;
  if (cfg.trustAny) return true;
  return isTrustedProxyIp((req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), cfg.entries);
}

/** Emit a startup warning if "auto" proxy mode is on — headers aren't verified. */
export function warnIfAutoProxyTrust(): void {
  if (proxyCfg().raw === 'auto') {
    log.warn(
      'Webchat: WEBCHAT_TRUSTED_PROXY_IPS=auto — headers are NOT cryptographically verified. ' +
        'Ensure this server is ONLY reachable through your proxy (Azure/Cloudflare). ' +
        'Direct access allows header forgery. Use explicit IP/CIDR for defense-in-depth.',
    );
  }
}

// ── Internals ─────────────────────────────────────────────────────────────

function extractBearer(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const wsProto = req.headers['sec-websocket-protocol'];
  if (!wsProto) return undefined;
  const protos = (Array.isArray(wsProto) ? wsProto.join(',') : wsProto).split(',').map((s) => s.trim());
  const bearer = protos.find((p) => p.startsWith('bearer.'));
  return bearer ? bearer.slice('bearer.'.length) : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isLocalhost(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(network) & mask);
}

function isTrustedProxyIp(ip: string, entries: string[]): boolean {
  for (const entry of entries) {
    if (entry.includes('/')) {
      if (isIpInCidr(ip, entry)) return true;
    } else {
      if (ip === entry) return true;
    }
  }
  return false;
}

function authenticateTrustedProxy(req: IncomingMessage, remoteIp: string): { identity: string } | null {
  const cleanIp = remoteIp.replace(/^::ffff:/, '');
  const cfg = proxyCfg();
  if (!cfg.raw) return null;

  // Step 1 — the IP gate. This is the ONLY thing the trust mode changes.
  //   "auto" / "*"  → no gate. Safe only when the server is reachable
  //                   EXCLUSIVELY through the proxy (see the header note above).
  //   explicit list → the hop must match, so a direct :PORT hit from anywhere
  //                   else cannot assert an identity at all.
  if (!cfg.trustAny) {
    if (cfg.entries.length === 0) return null;
    if (!isTrustedProxyIp(cleanIp, cfg.entries)) return null;
  }

  // Step 2 — resolve the identity. BOTH modes consult the same headers.
  //
  // Keeping these two concerns apart matters. Pinning the proxy IP tightens
  // *who may assert an identity*; it must not also narrow *which headers
  // carry one*. It used to do both: an explicit IP list read only
  // TRUSTED_PROXY_HEADER and skipped the platform pairs entirely, so an
  // operator hardening `auto` → a specific IP would silently 401 every
  // EasyAuth / Cloudflare Access login on the box — the tightening you'd
  // reach for first is exactly the one that broke sign-in.
  for (const ph of PLATFORM_HEADERS) {
    const identity = req.headers[ph.identity];
    const proof = req.headers[ph.verify];
    if (identity && proof) {
      const user = Array.isArray(identity) ? identity[0] : identity;
      // Non-empty: an empty identity header would otherwise mint `webchat:`
      // with no handle and collide across callers.
      if (typeof user === 'string' && user) {
        log.debug('Webchat platform proxy auth', {
          identity: user,
          platform: ph.name,
          remoteIp: cleanIp,
        });
        return { identity: user };
      }
    }
  }

  const rawUser = req.headers[cfg.header];
  const user = Array.isArray(rawUser) ? rawUser[0] : rawUser;
  if (typeof user !== 'string' || !user) return null;
  log.debug('Webchat trusted proxy auth', { identity: user, remoteIp: cleanIp });
  return { identity: user };
}

/**
 * Identity from a `tailscale serve` HTTPS front. Serve proxies from loopback
 * and injects `Tailscale-User-Login` — the tailnet login, the same string
 * whois returns as `UserProfile.LoginName`, so both paths mint an identical
 * `webchat:tailscale:<login>` id. Honor it ONLY when the request arrives on
 * loopback: serve is always localhost→localhost, so this header from a
 * non-loopback source is a spoof (a direct :PORT hit) and must be rejected.
 * Exported so that security boundary is unit-tested directly.
 */
export function tailscaleServeIdentity(req: IncomingMessage, remoteIp: string): string | null {
  if (!isLocalhost(remoteIp)) return null;
  const raw = req.headers['tailscale-user-login'];
  const login = Array.isArray(raw) ? raw[0] : raw;
  return typeof login === 'string' && login.trim() ? login.trim() : null;
}

async function tailscaleWhois(ip: string): Promise<string | null> {
  const cleanIp = ip.replace(/^::ffff:/, '');
  return new Promise((resolve) => {
    execFile('tailscale', ['whois', '--json', cleanIp], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(stdout) as {
          UserProfile?: { LoginName?: string };
          Node?: { Hostinfo?: { Hostname?: string } };
        };
        resolve(data?.UserProfile?.LoginName || data?.Node?.Hostinfo?.Hostname || null);
      } catch {
        resolve(null);
      }
    });
  });
}

function normalizeId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9._@+-]/g, '-');
}

/**
 * Canonicalize a webchat user_id so a hand-entered / granted id matches EXACTLY
 * what authenticateRequest() mints when that person actually logs in. Without
 * it, granting `webchat:Sam@Example.com` never matches the
 * `webchat:sam@example.com` the proxy-header (SSO/Entra) path produces.
 *
 *   webchat:tailscale:<id>  → webchat:tailscale:<normalizeId(id)>
 *   webchat:<id>            → webchat:<normalizeId(id)>
 *
 * These are the only two webchat id shapes authenticateRequest emits (tailscale
 * and proxy-header/bearer). Non-webchat ids (slack:…, discord:…) pass through
 * untouched — their handles belong to other channels and must not be folded.
 */
export function canonicalizeWebchatUserId(id: string): string {
  const parts = id.split(':');
  if (parts[0] !== 'webchat' || parts.length < 2) return id;
  if (parts[1] === 'tailscale') {
    const handle = parts.slice(2).join(':');
    return handle ? `webchat:tailscale:${normalizeId(handle)}` : id;
  }
  const handle = parts.slice(1).join(':');
  return handle ? `webchat:${normalizeId(handle)}` : id;
}

/**
 * A browser on THIS machine that the server will not sign in: it came over
 * loopback, named the host `localhost` (so it is not a proxy forwarding a
 * visitor under the public name), carries no Serve identity, and nothing else
 * it sent authenticates it. With Tailscale sign-in on, such a visitor should
 * be sent to the tailnet address, where the same person IS signed in. Quiet:
 * no audit row for the probe itself.
 */
export async function loopbackVisitorWithoutSignIn(req: IncomingMessage): Promise<boolean> {
  if (!tailscaleEnabled()) return false;
  const remoteIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!isLocalhost(remoteIp)) return false;
  const host = String(req.headers.host ?? '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
  if (req.headers['tailscale-user-login']) return false;
  return !(await authenticate(req)).ok;
}

/** The Origin header names this same host (or is absent, as for non-browser clients). */
function sameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host ?? '');
  } catch {
    return false;
  }
}

/**
 * This request's Tailscale identity, as a user id — for linking it to the
 * account signed in some other way. Null when Tailscale auth is off or the
 * caller is not a tailnet peer.
 */
export async function tailscaleIdentityOf(req: IncomingMessage): Promise<{ userId: string; login: string } | null> {
  if (!tailscaleEnabled()) return null;
  const remoteIp = (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
  const login = tailscaleServeIdentity(req, remoteIp) ?? (await tailscaleWhois(remoteIp));
  return login ? { userId: `webchat:tailscale:${normalizeId(login)}`, login } : null;
}

/** The user id a verified OIDC identity signs in as, before links. */
export function oidcUserId(identity: string): string {
  return `webchat:${normalizeId(identity)}`;
}

async function finalize(args: {
  source: AuthResult['source'];
  userId: string;
  displayName: string;
}): Promise<AuthResult> {
  // A sign-in linked to another account (signins.ts) authenticates AS that
  // account. The shared bearer token and the localhost owner are not a person
  // and are never linked.
  if (args.source !== 'bearer' && args.source !== 'localhost') {
    const account = await resolveLinkedUserId(args.userId);
    if (account !== args.userId) {
      await ensureOwnerRoleOnFirstLogin(account);
      return { ok: true, userId: account, displayName: args.displayName, source: args.source, signedInAs: args.userId };
    }
  }
  // Upsert the users row so every authenticated identity is visible in the
  // Permissions UI even before any role is granted. The display_name is
  // refreshed on each connect (upsert preserves null with COALESCE if the
  // adapter doesn't have one).
  //
  // Guarded behind hasTable so a deployment without the permissions module
  // still authenticates instead of throwing on a missing FK.
  if (await hasTable(getDb(), 'users')) {
    try {
      await upsertUser({
        id: args.userId,
        kind: 'webchat',
        display_name: args.displayName || null,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      log.warn('Webchat: upsertUser failed during auth finalize', { userId: args.userId, err });
    }
  }
  await ensureOwnerRoleOnFirstLogin(args.userId);
  // One-shot: if the operator opted into Tailscale in the wizard, the FIRST
  // tailscale identity to authenticate is promoted to owner (co-owner with the
  // bearer bootstrap), then the flag disarms so later tailnet peers don't get it.
  if (args.source === 'tailscale' && (await getPromoteFirstTailscaleOwner())) {
    const granted = await grantOwnerRole(args.userId, 'webchat:first-tailscale-owner');
    // Disarm on the END STATE, not on the return value. `granted` is false in
    // two very different cases — the grant failed, and this identity already
    // held owner — and clearing the flag unconditionally conflates them. That
    // conflation is unrecoverable in the direction that matters: the one-shot
    // is spent, no role exists, and the operator is left holding a tailnet
    // identity that can authenticate but not administer, with the only UI for
    // re-arming gated behind the owner they just failed to become.
    if (granted || (await isOwner(args.userId))) await setPromoteFirstTailscaleOwner(false);
  }
  return { ok: true, userId: args.userId, displayName: args.displayName, source: args.source };
}
