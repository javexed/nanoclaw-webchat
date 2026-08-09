/**
 * Webchat HTTP/WS authentication.
 *
 * Auth methods (any combination, controlled by env presence):
 *   - localhost                always passes when remote IP is loopback
 *   - bearer token             WEBCHAT_TOKEN set; matched constant-time
 *   - tailscale whois          IP looked up via `tailscale whois --json`
 *   - trusted-proxy header     WEBCHAT_TRUSTED_PROXY_IPS = "auto" | "*" | csv
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
import { timingSafeEqual } from 'crypto';

import { audit } from '../../audit.js';
import { hasTable, getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { getBearerTokenDisabled, getPromoteFirstTailscaleOwner, setPromoteFirstTailscaleOwner } from './db.js';
import { ensureOwnerRoleOnFirstLogin, grantOwnerRole, isOwner } from './roles.js';

const WEBCHAT_TOKEN = process.env.WEBCHAT_TOKEN || '';
const TRUSTED_PROXY_RAW = (process.env.WEBCHAT_TRUSTED_PROXY_IPS || '').trim();
const TRUSTED_PROXY_HEADER = (process.env.WEBCHAT_TRUSTED_PROXY_HEADER || 'x-forwarded-user').toLowerCase();
const TAILSCALE_ENABLED = process.env.WEBCHAT_TAILSCALE === 'true';
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
 * Trusted proxy modes:
 *   "auto" — accept identity from any platform-managed proxy. Detects per
 *            request (Azure EasyAuth, Cloudflare Access). Headers are NOT
 *            cryptographically verified — only safe if the server is reachable
 *            EXCLUSIVELY through the proxy.
 *   "*"    — trust the configured header from any source IP (most permissive)
 *   IP/CIDR list — explicit allowlist (recommended)
 */
const TRUST_ANY_PLATFORM = TRUSTED_PROXY_RAW === 'auto' || TRUSTED_PROXY_RAW === '*';

const TRUSTED_PROXY_ENTRIES = TRUST_ANY_PLATFORM
  ? []
  : TRUSTED_PROXY_RAW.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

const PLATFORM_HEADERS: Array<{ identity: string; verify: string; name: string }> = [
  // Azure App Service EasyAuth — x-ms-client-principal is a signed blob the platform injects.
  { identity: 'x-ms-client-principal-name', verify: 'x-ms-client-principal', name: 'Azure EasyAuth' },
  // Cloudflare Access — Cf-Access-Jwt-Assertion accompanies the email header.
  { identity: 'cf-access-authenticated-user-email', verify: 'cf-access-jwt-assertion', name: 'Cloudflare Access' },
];

export interface AuthResult {
  ok: true;
  userId: string;
  displayName: string;
  source: 'localhost' | 'bearer' | 'tailscale' | 'proxy-header';
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

  // 1. Bearer token from Authorization header or WebSocket subprotocol.
  //    PWA passes via `Sec-WebSocket-Protocol: bearer.<token>` so the secret
  //    stays out of URLs (and therefore out of proxy access logs).
  const providedToken = extractBearer(req);
  if ((await bearerActive()) && providedToken && safeEqual(providedToken, WEBCHAT_TOKEN)) {
    return finalize({ source: 'bearer', userId: 'webchat:owner', displayName: 'operator' });
  }

  // 2. Trusted proxy header — proxy is the auth authority.
  const proxy = authenticateTrustedProxy(req, remoteIp);
  if (proxy) {
    return finalize({
      source: 'proxy-header',
      userId: `webchat:${normalizeId(proxy.identity)}`,
      displayName: proxy.identity,
    });
  }

  // 3. Tailscale identity.
  if (TAILSCALE_ENABLED) {
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
      return finalize({
        source: 'tailscale',
        userId: `webchat:tailscale:${normalizeId(serveLogin)}`,
        displayName: serveLogin,
      });
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

/** True when at least one non-localhost auth method is currently usable. */
export async function hasExplicitAuth(): Promise<boolean> {
  return (await bearerActive()) || TAILSCALE_ENABLED || TRUSTED_PROXY_RAW.length > 0;
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
      if (wasHealthy !== false && TAILSCALE_ENABLED) {
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
  methods: { bearer: boolean; tailscale: boolean; proxy: boolean };
  tailscaleHealthy: boolean;
}> {
  refreshTailscaleHealth(); // background re-probe if stale; returns cached value now
  return {
    methods: {
      bearer: await bearerActive(),
      tailscale: TAILSCALE_ENABLED,
      proxy: TRUSTED_PROXY_RAW.length > 0,
    },
    // Pre-auth login hint: only advertise tailscale health when it's actually an
    // enabled auth method here. Raw host-presence (probe result) is exposed to
    // the owner via getAuthManagementInfo, not to unauthenticated callers.
    tailscaleHealthy: TAILSCALE_ENABLED && tailscaleHealthy === true,
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
  loopback: boolean;
  hasAlternativeAuth: boolean;
  canDisableBearer: boolean;
  canEnableBearer: boolean;
}> {
  refreshTailscaleHealth(); // background re-probe if stale; returns cached value now
  const proxy = TRUSTED_PROXY_RAW.length > 0;
  const tailscaleUsable = TAILSCALE_ENABLED && tailscaleHealthy === true;
  const hasAlternativeAuth = tailscaleUsable || proxy;
  const active = await bearerActive();
  return {
    bearerConfigured: Boolean(WEBCHAT_TOKEN),
    bearerActive: active,
    tailscale: { enabled: TAILSCALE_ENABLED, healthy: tailscaleHealthy === true },
    proxy,
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

/** Emit a startup warning if "auto" proxy mode is on — headers aren't verified. */
export function warnIfAutoProxyTrust(): void {
  if (TRUSTED_PROXY_RAW === 'auto') {
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

function isTrustedProxyIp(ip: string): boolean {
  for (const entry of TRUSTED_PROXY_ENTRIES) {
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

  if (TRUST_ANY_PLATFORM) {
    // First try platform-managed headers (paired identity + signed proof).
    for (const ph of PLATFORM_HEADERS) {
      const identity = req.headers[ph.identity];
      const proof = req.headers[ph.verify];
      if (identity && proof) {
        const user = Array.isArray(identity) ? identity[0] : identity;
        if (typeof user === 'string') {
          log.debug('Webchat platform proxy auth', { identity: user, platform: ph.name });
          return { identity: user };
        }
      }
    }
    // Fall back to the configured header from any source.
    const rawUser = req.headers[TRUSTED_PROXY_HEADER];
    const user = Array.isArray(rawUser) ? rawUser[0] : rawUser;
    if (typeof user === 'string' && user) {
      log.debug('Webchat trusted proxy auth (auto fallback)', { identity: user, remoteIp: cleanIp });
      return { identity: user };
    }
    return null;
  }

  if (TRUSTED_PROXY_ENTRIES.length === 0) return null;
  if (!isTrustedProxyIp(cleanIp)) return null;
  const rawUser = req.headers[TRUSTED_PROXY_HEADER];
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

async function finalize(args: {
  source: AuthResult['source'];
  userId: string;
  displayName: string;
}): Promise<AuthResult> {
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
    if ((await granted) || (await isOwner(args.userId))) setPromoteFirstTailscaleOwner(false);
  }
  return { ok: true, userId: args.userId, displayName: args.displayName, source: args.source };
}
