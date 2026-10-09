/**
 * MCP server credentials, host-side.
 *
 * Credentials live in webchat_mcp_servers.auth — a JSON column the relay and
 * the health probe read. They are NEVER materialized into container.json:
 * containers reach authenticated servers through the relay (mcp-relay.ts),
 * which injects the Authorization header at forward time.
 *
 * Two kinds:
 *   { kind: 'bearer', token }            — a static token the operator pasted.
 *   { kind: 'oauth', ...token state }    — OAuth 2.1 authorization-code + PKCE.
 *
 * OAuth notes for THIS topology (host on a private tailnet):
 *   - Discovery: RFC 9728 protected-resource metadata on the server's origin →
 *     RFC 8414 authorization-server metadata (OIDC fallback).
 *   - Client registration: DCR (RFC 7591). CIMD (the spec's successor) needs
 *     the AUTH SERVER to fetch a client-metadata URL — our tailnet URL is not
 *     publicly reachable, so CIMD cannot work here; DCR is an outbound POST
 *     from us and works fine. Static client_id entry is the fallback for auth
 *     servers without DCR.
 *   - The redirect URI is browser-side only (the admin's browser is on the
 *     tailnet), so the callback on our TLS listener is reachable where needed.
 */
import { createHash, randomBytes } from 'crypto';

import { log } from '../../log.js';
import { getWebchatMcpServer, setMcpServerAuth, type WebchatMcpServer } from './mcp-registry.js';
import { safeFetch } from './models.js';

export interface McpAuthBearer {
  kind: 'bearer';
  token: string;
}

export interface McpAuthOAuth {
  kind: 'oauth';
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  authorization_endpoint: string;
  resource: string;
  scope?: string;
  access_token?: string;
  refresh_token?: string;
  /** ms epoch when access_token expires (0/absent = unknown, treat as live). */
  expires_at?: number;
}

export type McpAuth = McpAuthBearer | McpAuthOAuth;

// ── Outbound policy ──────────────────────────────────────────────────────────
//
// Every URL below except the MCP server's own comes from metadata the server
// (or the authorization server it names) publishes, so each fetch goes through
// safeFetch: the SSRF gate runs on every hop (cloud metadata and link-local
// always refused; private ranges too under WEBCHAT_BLOCK_PRIVATE_IPS), and the
// local router's key is never attached. Requests that carry a credential (a
// token grant, a client registration) refuse redirects outright.
//
// Credential endpoints must be https. The one exception keeps a plain-http
// MCP server on the LAN or tailnet working, which is how such servers are
// usually registered: when the server's own URL is http, an http endpoint on
// that SAME host is accepted — the operator already trusts that host in the
// clear. Any other host, or an https server naming an http endpoint, is
// refused. Checked when the flow starts and again before every grant, so a
// stored token_endpoint is re-judged against the server's current URL.

const GET_OPTS = { redirects: 'follow', routerAuth: false } as const;
const CREDENTIAL_OPTS = { redirects: 'refuse', routerAuth: false } as const;

/** Throws unless `endpoint` may receive credentials for the server at `serverUrl`. */
export function assertCredentialEndpoint(endpoint: string, serverUrl: string | null | undefined, what: string): void {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error(`The ${what} is not a valid URL`);
  }
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && serverUrl) {
    try {
      const s = new URL(serverUrl);
      if (s.protocol === 'http:' && s.hostname.toLowerCase() === u.hostname.toLowerCase()) return;
    } catch {
      /* fall through to the refusal */
    }
  }
  throw new Error(`The ${what} must use https (http only on the MCP server's own http host)`);
}

/** The server's URL, for re-judging a stored endpoint. Null if the row is gone. */
async function serverUrlFor(serverId: string): Promise<string | null> {
  return (await getWebchatMcpServer(serverId))?.url ?? null;
}

export function parseMcpAuth(row: Pick<WebchatMcpServer, 'auth'>): McpAuth | null {
  if (!row.auth) return null;
  try {
    const a = JSON.parse(row.auth) as McpAuth;
    return a && (a.kind === 'bearer' || a.kind === 'oauth') ? a : null;
  } catch {
    return null;
  }
}

/**
 * The Authorization header for a server right now — refreshing an expired
 * OAuth access token first (persisted back to the row). Null when the server
 * has no host-side auth.
 */
export async function effectiveAuthHeader(server: WebchatMcpServer): Promise<string | null> {
  const auth = parseMcpAuth(server);
  if (!auth) return null;
  if (auth.kind === 'bearer') return `Bearer ${auth.token}`;
  if (auth.expires_at && Date.now() > auth.expires_at - 30_000 && auth.refresh_token) {
    const refreshed = await refreshOAuthToken(server.id, auth);
    if (refreshed?.access_token) return `Bearer ${refreshed.access_token}`;
  }
  return auth.access_token ? `Bearer ${auth.access_token}` : null;
}

/** Refresh-token grant; persists the new token state. Null on failure. */
export async function refreshOAuthToken(serverId: string, auth: McpAuthOAuth): Promise<McpAuthOAuth | null> {
  if (!auth.refresh_token) return null;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      client_id: auth.client_id,
      resource: auth.resource,
    });
    if (auth.client_secret) body.set('client_secret', auth.client_secret);
    assertCredentialEndpoint(auth.token_endpoint, await serverUrlFor(serverId), 'token endpoint');
    const r = await safeFetch(
      auth.token_endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      },
      CREDENTIAL_OPTS,
    );
    if (!r.ok) {
      log.warn('MCP OAuth refresh failed', { serverId, status: r.status });
      return null;
    }
    const tok = (await r.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tok.access_token) return null;
    const next: McpAuthOAuth = {
      ...auth,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || auth.refresh_token,
      expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
    };
    await setMcpServerAuth(serverId, next as unknown as Record<string, unknown>);
    return next;
  } catch (err) {
    log.warn('MCP OAuth refresh threw', { serverId, err: String(err) });
    return null;
  }
}

// ── Authorization-code flow ──────────────────────────────────────────────────

interface PendingOAuth {
  serverId: string;
  verifier: string;
  redirectUri: string;
  meta: {
    client_id: string;
    client_secret?: string;
    token_endpoint: string;
    authorization_endpoint: string;
    resource: string;
    scope?: string;
  };
  at: number;
  /** Who started the flow; only they may finish it. */
  startedBy: string;
}

const pending = new Map<string, PendingOAuth>(); // key = state
const PENDING_TTL_MS = 10 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface AsMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

/** RFC 9728 → RFC 8414 (OIDC fallback) discovery from the MCP server's URL. */
export async function discoverAuthServer(serverUrl: string): Promise<AsMetadata & { resource: string }> {
  const origin = new URL(serverUrl).origin;
  let asUrls: string[] = [];
  let resource = serverUrl;
  try {
    const r = await safeFetch(
      `${origin}/.well-known/oauth-protected-resource`,
      { signal: AbortSignal.timeout(8000) },
      GET_OPTS,
    );
    if (r.ok) {
      const prm = (await r.json()) as { authorization_servers?: string[]; resource?: string };
      asUrls = prm.authorization_servers || [];
      if (prm.resource) resource = prm.resource;
    }
  } catch {
    /* fall through — many servers are their own auth server */
  }
  if (asUrls.length === 0) asUrls = [origin];
  for (const as of asUrls) {
    const base = as.replace(/\/$/, '');
    for (const wk of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      try {
        const r = await safeFetch(`${base}${wk}`, { signal: AbortSignal.timeout(8000) }, GET_OPTS);
        if (!r.ok) continue;
        const meta = (await r.json()) as AsMetadata;
        if (meta.authorization_endpoint && meta.token_endpoint) return { ...meta, resource };
      } catch {
        continue;
      }
    }
  }
  throw new Error('No OAuth authorization server discovered for this MCP server');
}

/** RFC 7591 dynamic client registration. Returns null when unsupported. */
async function registerClient(
  meta: AsMetadata,
  redirectUri: string,
  serverUrl: string,
): Promise<{ client_id: string; client_secret?: string } | null> {
  if (!meta.registration_endpoint) return null;
  // The endpoint that answers here hands back a client_secret; it is held to
  // the same rule as the token endpoint.
  assertCredentialEndpoint(meta.registration_endpoint, serverUrl, 'registration endpoint');
  try {
    const r = await safeFetch(
      meta.registration_endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'NanoClaw',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        signal: AbortSignal.timeout(10_000),
      },
      CREDENTIAL_OPTS,
    );
    if (!r.ok) return null;
    const c = (await r.json()) as { client_id?: string; client_secret?: string };
    return c.client_id ? { client_id: c.client_id, client_secret: c.client_secret } : null;
  } catch (err) {
    log.warn('MCP OAuth client registration failed', { err: String(err) });
    return null;
  }
}

/**
 * Begin the flow: discovery → DCR (or operator-supplied client id) → PKCE
 * authorize URL. Caller redirects the admin's browser there.
 */
export async function startOAuthFlow(
  serverId: string,
  redirectUri: string,
  staticClient: { client_id: string; client_secret?: string } | undefined,
  startedBy: string,
): Promise<string> {
  const server = await getWebchatMcpServer(serverId);
  if (!server?.url) throw new Error('Not a remote MCP server');
  const meta = await discoverAuthServer(server.url);
  assertCredentialEndpoint(meta.token_endpoint!, server.url, 'token endpoint');
  // The admin's browser is sent here, never the host — but only to a web URL.
  if (!/^https?:$/.test(new URL(meta.authorization_endpoint!).protocol)) {
    throw new Error('The authorization endpoint must be an http(s) URL');
  }
  const client = staticClient?.client_id ? staticClient : await registerClient(meta, redirectUri, server.url);
  if (!client) {
    throw new Error('The authorization server does not support dynamic registration — supply a client ID');
  }
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(24));
  const scope = meta.scopes_supported?.length ? meta.scopes_supported.join(' ') : undefined;
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL_MS) pending.delete(k);
  pending.set(state, {
    serverId,
    verifier,
    redirectUri,
    at: Date.now(),
    startedBy,
    meta: {
      client_id: client.client_id,
      client_secret: client.client_secret,
      token_endpoint: meta.token_endpoint!,
      authorization_endpoint: meta.authorization_endpoint!,
      resource: meta.resource,
      scope,
    },
  });
  const u = new URL(meta.authorization_endpoint!);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', client.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  u.searchParams.set('resource', meta.resource); // RFC 8707 audience binding
  if (scope) u.searchParams.set('scope', scope);
  return u.toString();
}

/** Token exchange on callback. Persists auth to the server row. */
export async function finishOAuthFlow(state: string, code: string, userId: string): Promise<{ serverId: string }> {
  const p = pending.get(state);
  if (!p || Date.now() - p.at > PENDING_TTL_MS) throw new Error('OAuth state expired — start again');
  // Another signed-in user landing on this callback (a forwarded link) must
  // not connect the server to an account of their choosing. The state stays
  // live, so the admin who started the flow can still finish it.
  if (p.startedBy !== userId) throw new Error('This sign-in was started by someone else — start it again yourself');
  pending.delete(state);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: p.redirectUri,
    client_id: p.meta.client_id,
    code_verifier: p.verifier,
    resource: p.meta.resource,
  });
  if (p.meta.client_secret) body.set('client_secret', p.meta.client_secret);
  assertCredentialEndpoint(p.meta.token_endpoint, await serverUrlFor(p.serverId), 'token endpoint');
  const r = await safeFetch(
    p.meta.token_endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    },
    CREDENTIAL_OPTS,
  );
  if (!r.ok) {
    // The body is the remote server's text, and this message reaches the
    // browser: report the status only, and log only the status here too.
    log.warn('MCP OAuth token exchange failed', { serverId: p.serverId, status: r.status });
    throw new Error(`Token exchange failed (HTTP ${r.status})`);
  }
  const tok = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tok.access_token) throw new Error('Token endpoint returned no access_token');
  const auth: McpAuthOAuth = {
    kind: 'oauth',
    client_id: p.meta.client_id,
    client_secret: p.meta.client_secret,
    token_endpoint: p.meta.token_endpoint,
    authorization_endpoint: p.meta.authorization_endpoint,
    resource: p.meta.resource,
    scope: p.meta.scope,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
  };
  await setMcpServerAuth(p.serverId, auth as unknown as Record<string, unknown>);
  return { serverId: p.serverId };
}
