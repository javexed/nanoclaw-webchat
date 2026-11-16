// ── Auth token + fetch helpers ───────────────────────────────────────────────
// The token is private and reached through accessors: an ES import binding
// cannot be reassigned by an importer, and the token changes on login and mint.

// sessionStorage (not localStorage). Precision matters here: sessionStorage is
// fully readable by ANY script running in this page, so it does NOT protect the
// token from XSS — the CSP and sanitizer do that. What it buys is scope: no
// persistence across restarts and no sharing across tabs, so a token can't be
// lifted later from a long-lived localStorage entry. The real exfil guards are
// elsewhere: the token travels only in the Authorization header on same-origin
// relative URLs and in the WS subprotocol — never in a URL.
import { noteAuthHint } from './platform-token.js';
import { checkSessionExpired, sessionExpiredShown } from './session-expiry.js';

let authToken: string = sessionStorage.getItem('nanoclaw-token') || '';

export function getAuthToken(): string {
  return authToken;
}

export function setAuthToken(token: string): void {
  authToken = token;
}

export function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

// Bearer goes in the WebSocket subprotocol (Sec-WebSocket-Protocol) instead of
// the URL — keeps it out of proxy logs and browser history.
export function getWsProtocols(): string[] {
  return authToken ? [`bearer.${authToken}`] : [];
}

export function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const headers = { ...(opts.headers as Record<string, string> | undefined) };
  if (authToken && !headers['Authorization'] && !headers['authorization']) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  // CSRF guard — server requires this on multipart/chunked upload endpoints so
  // cross-origin form-POSTs can't auto-attach credentials.
  headers['X-Webchat-CSRF'] = '1';
  // Signed out at the front door: hold every request until the reload rather
  // than letting each poll fail into the console.
  if (sessionExpiredShown()) return PAUSED();
  return fetch(url, { ...opts, headers }).then(
    (res) => {
      // Every authenticated response may carry the platform-token hint.
      noteAuthHint(res);
      return res;
    },
    async (err: unknown) => {
      // A network-level failure on our own origin is what an expired front-door
      // session looks like to fetch (the redirect to the sign-in page is
      // blocked): the WebSocket stays up through it, so this is often the only
      // place it shows. Ask once; when it is, the banner takes over.
      if (url.startsWith('/') && !url.startsWith('//') && (await expiredOnce())) return PAUSED();
      throw err;
    },
  );
}

/** A request that never settles: callers stay quiet while the banner is up. */
const PAUSED = (): Promise<Response> => new Promise<Response>(() => {});

/** One check at a time: a burst of failed polls shares it. */
let checking: Promise<boolean> | null = null;
function expiredOnce(): Promise<boolean> {
  if (sessionExpiredShown()) return Promise.resolve(true);
  checking ??= checkSessionExpired().finally(() => {
    checking = null;
  });
  return checking;
}

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

/** authFetch + JSON ceremony in one call. Sends a JSON body when `body` is
 * given, parses the JSON response (tolerating empty/non-JSON), and throws
 * Error(body.error || statusText) on !ok. Options: { method, body, headers }. */
export async function apiJson(
  url: string,
  { method = 'GET', body, headers }: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<any> {
  const opts: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await authFetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = new Error(data.error || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}
