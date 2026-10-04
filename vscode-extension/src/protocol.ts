// The runner wire protocol — shared shape with server runner-ws.ts.
// Pure: no vscode, no sockets, so it is unit-testable.
// Under /ws/ so the relay's `location /ws` (the only one that forwards the
// WebSocket Upgrade headers) carries it.
export const RUNNER_WS_PATH = '/ws/runner';

/**
 * Why an upgrade was refused, in the user's terms. A 403 is not always the
 * token: App Service's access restrictions answer "403 Ip Forbidden" (with the
 * address they saw) before sign-in or central are reached — a laptop whose
 * editor leaves by another route than its browser.
 */
export function upgradeRefusal(code: number, statusMessage?: string, forbiddenIp?: string | string[]): string {
  const ip = Array.isArray(forbiddenIp) ? forbiddenIp[0] : forbiddenIp;
  if (code === 403 && (ip || /ip forbidden/i.test(statusMessage ?? '')))
    return `the App Service does not allow this machine's network address${ip ? ` (${ip})` : ''}; check VS Code's proxy settings or the App Service access restrictions`;
  return `server refused the token (HTTP ${code})`;
}
export const PROTOCOL_VERSION = 1;
export interface Machine {
  fingerprint: string;
  hostname: string;
  os: string;
  arch: string;
  runner: string;
  /** Ed25519 public key, SPKI DER in base64 (machine-key.ts). */
  publicKey?: string;
}
export type Frame = { type: string; [k: string]: unknown };

export function wsUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = RUNNER_WS_PATH;
  u.search = '';
  u.hash = '';
  return u.toString();
}
/**
 * May the bearer token, or an update package and the hash that vouches for it,
 * travel to this origin? Only over TLS, or when it never leaves the machine.
 */
export function secureOrigin(serverUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    return false;
  }
  if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
  return (u.protocol === 'http:' || u.protocol === 'ws:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}
/**
 * What the machine key signs in answer to central's challenge: bound to the
 * fingerprint and to the origin this machine dialled, so a signature obtained
 * by some other server does not verify at central. Same shape as runner-ws.ts.
 */
export const MACHINE_KEY_CONTEXT = 'nanoclaw-runner-key-v1';
export function machineKeyMessage(fingerprint: string, origin: string, nonce: string): string {
  return `${MACHINE_KEY_CONTEXT}\n${fingerprint}\n${origin}\n${nonce}`;
}
/** `standby`: take the connection only if no other window on this machine holds it (central answers 4409 held). */
export const helloFrame = (machine: Machine, standby = false): Frame => ({
  type: 'hello',
  v: PROTOCOL_VERSION,
  machine,
  ...(standby ? { standby: true } : {}),
});

/** Reply to a server frame, or null if none is due. */
export function replyFor(frame: Frame): Frame | null {
  return frame.type === 'ping' ? { type: 'pong', t: frame.t } : null;
}
/** Bounded exponential backoff: 1s → 30s, reset by the caller after a good session. */
export function nextBackoff(current: number): number {
  return Math.min(Math.max(current, 1000) * 2, 30_000);
}
/**
 * How this laptop proves who it is to central.
 *   microsoft  an Entra token from VS Code's Microsoft sign-in (App Service installs)
 *   network    no token: central knows the caller by its network identity —
 *              Tailscale whois on a tailnet, or an identity-aware proxy's headers
 */
export type SignIn = 'microsoft' | 'network';

/** The Authorization header for a token, or none: under `network` sign-in there is no token to send. */
/**
 * The claims that say who a sign-in token is for, for the log: never the token
 * itself or its signature. `azp`/`appid` is the app VS Code signed in as.
 */
export function tokenClaimsSummary(token: string): string {
  if (!token) return 'no token';
  try {
    const c = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const exp = typeof c.exp === 'number' ? new Date(c.exp * 1000).toISOString() : '?';
    return ['aud', 'azp', 'appid', 'ver', 'scp']
      .filter((k) => c[k] !== undefined)
      .map((k) => `${k}=${String(c[k])}`)
      .concat(`exp=${exp}`)
      .join(' ');
  } catch {
    return 'token not readable';
  }
}

/** The response headers that tell which layer refused an upgrade (a proxy, App Service, central). */
export function refusalHeaders(headers: Record<string, string | string[] | undefined>): string {
  return (
    ['server', 'www-authenticate', 'x-ms-middleware-request-id', 'x-ms-forbidden-ip', 'x-powered-by', 'via']
      .filter((k) => headers[k] !== undefined)
      .map((k) => `${k}: ${String(headers[k]).slice(0, 300)}`)
      .join('; ') || 'no identifying headers'
  );
}

export function authHeader(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Scopes for VS Code's Microsoft provider: our API's delegated scope, plus the
 *  pseudo-scopes that pick a tenant and (optionally) our own app registration. */
export function scopesFor(appIdUri: string, tenantId: string, clientId?: string): string[] {
  const s = [`${appIdUri.replace(/\/$/, '')}/user_impersonation`];
  if (tenantId) s.push(`VSCODE_TENANT:${tenantId}`);
  if (clientId) s.push(`VSCODE_CLIENT_ID:${clientId}`);
  return s;
}
