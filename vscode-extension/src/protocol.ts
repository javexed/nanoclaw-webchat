// The runner wire protocol — shared shape with server runner-ws.ts.
// Pure: no vscode, no sockets, so it is unit-testable.
// Under /ws/ so the relay's `location /ws` (the only one that forwards the
// WebSocket Upgrade headers) carries it.
export const RUNNER_WS_PATH = '/ws/runner';
export const PROTOCOL_VERSION = 1;
export interface Machine {
  fingerprint: string;
  hostname: string;
  os: string;
  arch: string;
  runner: string;
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
export const helloFrame = (machine: Machine): Frame => ({ type: 'hello', v: PROTOCOL_VERSION, machine });

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
