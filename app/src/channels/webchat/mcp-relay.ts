/**
 * MCP auth relay — the host-side hop that keeps MCP credentials out of
 * containers.
 *
 * A remote MCP server with host-side auth (webchat_mcp_servers.auth) is synced
 * into container configs with its url REWRITTEN to
 *   http://host.docker.internal:<port>/relay/<serverId>
 * plus a per-(agent group, server) relay token header. This listener validates
 * the token against the assignment row, injects the real Authorization header
 * (refreshing OAuth tokens as needed), and streams the exchange both ways —
 * Streamable HTTP POSTs and SSE GET streams alike.
 *
 * Trust model: the relay token is an indirection credential — it names one
 * (group, server) pair and is useless anywhere else. Revoking = unassigning.
 * The real secret never leaves the host. Plain HTTP is fine here: the only
 * legitimate path is the docker bridge (and tailnet links are WireGuard-
 * encrypted regardless); the token gates every request.
 *
 * Lifetime: binds only once a relay-backed assignment exists (at boot, or
 * lazily from `ensureRelayToken()`), so most installs never open the port. It
 * is not stopped when the last assignment goes: a container may still hold a
 * relay url, and teardown owns that.
 */
import http from 'http';
import os from 'os';
import { Readable } from 'stream';

import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { effectiveAuthHeader, parseMcpAuth, refreshOAuthToken } from './mcp-auth.js';
import { getWebchatMcpServer, MCP_RELAY_PORT } from './mcp-registry.js';
import { safeFetch } from './models.js';

export { MCP_RELAY_PORT };
const RELAY_TOKEN_HEADER = 'x-nanoclaw-relay';

/** Hop-by-hop / host-scoped headers that must not be forwarded either way. */
const STRIP_REQUEST = new Set(['host', 'connection', 'content-length', RELAY_TOKEN_HEADER, 'authorization']);
const STRIP_RESPONSE = new Set(['connection', 'transfer-encoding', 'content-length', 'keep-alive']);

async function lookupAssignment(token: string): Promise<{ agent_group_id: string; mcp_server_id: string } | undefined> {
  return (await getDb().get(
    `SELECT agent_group_id, mcp_server_id FROM webchat_agent_mcp_servers WHERE relay_token = ?`,
    token,
  )) as { agent_group_id: string; mcp_server_id: string } | undefined;
}

/**
 * Endpoints central serves itself on the relay port, by path prefix, for
 * installed modules (the VS Code runner's laptop tools). Each authenticates
 * its own callers: the relay only routes.
 */
type RelayRoute = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
const relayRoutes = new Map<string, RelayRoute>();
export function registerRelayRoute(prefix: string, route: RelayRoute): void {
  relayRoutes.set(prefix, route);
}

/** Repeated percent-decoding stops here; anything still encoded past it is refused. */
const MAX_DECODE_ROUNDS = 4;

/**
 * The upstream URL for a relayed request, or null when it would leave the
 * configured server. The relay injects a credential, so the agent may only
 * reach paths UNDER the server's configured URL, on its origin: no dot
 * segments (literal or percent-encoded, at any encoding depth), no
 * backslashes, and the URL as parsed must stay below the base path.
 */
export function relayTargetUrl(serverUrl: string, subPath: string, query: string): string | null {
  let base: URL;
  try {
    base = new URL(serverUrl);
  } catch {
    return null;
  }
  let decoded = subPath;
  for (let round = 0; ; round++) {
    if (decoded.includes('\\')) return null;
    if (decoded.split('/').some((seg) => seg === '.' || seg === '..')) return null;
    if (!/%[0-9a-f]{2}/i.test(decoded)) break;
    if (round === MAX_DECODE_ROUNDS) return null;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  let target: URL;
  try {
    target = new URL(`${base.origin}${basePath}${subPath}${query}`);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) return null;
  return target.toString();
}

async function handleRelay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url || '';
  for (const [prefix, route] of relayRoutes) {
    if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) return route(req, res);
  }
  const m = url.match(/^\/relay\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) {
    res.writeHead(404).end('not found');
    return;
  }
  const [, serverId, subPath = '', query = ''] = m;
  const token = String(req.headers[RELAY_TOKEN_HEADER] || '');
  const assignment = await (token ? lookupAssignment(token) : undefined);
  if (!assignment || assignment.mcp_server_id !== serverId) {
    res.writeHead(403).end('relay token invalid for this server');
    return;
  }
  const server = await getWebchatMcpServer(serverId);
  if (!server?.url) {
    res.writeHead(502).end('server has no URL');
    return;
  }
  // Confine before any credential is looked up: a path that would leave the
  // configured server is refused outright.
  const target = relayTargetUrl(server.url, subPath, query);
  if (!target) {
    res.writeHead(400).end('relay path outside the configured server');
    return;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP_REQUEST.has(k.toLowerCase()) || typeof v !== 'string') continue;
    headers[k] = v;
  }
  // Operator-set static headers still apply under the relay…
  try {
    Object.assign(headers, server.headers ? (JSON.parse(server.headers) as Record<string, string>) : {});
  } catch {
    /* malformed headers JSON — forward without */
  }
  // …and the host-side credential is injected last, so it always wins.
  const authHeader = await effectiveAuthHeader(server);
  if (authHeader) headers['authorization'] = authHeader;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';

  // safeFetch: the SSRF gate runs on the target, and a redirect is refused
  // rather than followed, so the credential never reaches a host the server
  // points it at. Never the router's master key either.
  const forward = async (): Promise<Response> =>
    safeFetch(
      target,
      {
        method: req.method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req) as unknown as RequestInit['body'], duplex: 'half' } : {}),
        signal: AbortSignal.timeout(10 * 60 * 1000), // long-poll friendly
      } as RequestInit,
      { redirects: 'refuse', routerAuth: false },
    );

  try {
    let upstream = await forward();
    // One retry on 401 with a fresh OAuth token — the classic mid-stream expiry.
    if (upstream.status === 401 && !hasBody) {
      const auth = parseMcpAuth(server);
      if (auth?.kind === 'oauth' && auth.refresh_token) {
        const refreshed = await refreshOAuthToken(server.id, auth);
        if (refreshed?.access_token) {
          headers['authorization'] = `Bearer ${refreshed.access_token}`;
          upstream = await forward();
        }
      }
    }
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      // Stream — SSE and chunked Streamable HTTP responses flow through live.
      Readable.fromWeb(upstream.body as never).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    log.warn('MCP relay forward failed', { serverId, err: String(err) });
    if (!res.headersSent) res.writeHead(502);
    res.end('relay forward failed');
  }
}

let relayServer: http.Server | null = null;
/** The loopback listener exec-relayed agents reach through central (exec-relay.ts). */
let loopbackServer: http.Server | null = null;
/** WEBCHAT_EXEC_RELAY=1: relayed agents dial the relay through central's own process, on loopback. */
const execRelayed = (): boolean => (process.env.WEBCHAT_EXEC_RELAY ?? '').trim() === '1';
const LOOPBACK = '127.0.0.1';

function relayHttpServer(): http.Server {
  const server = http.createServer((req, res) => {
    void handleRelay(req, res).catch((err) => {
      log.error('MCP relay handler threw', { err });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('error', (err) => log.error('MCP relay listener error', { err: String(err) }));
  return server;
}

export type RelayBind = { kind: 'bind'; host: string } | { kind: 'refuse'; reason: string };

/**
 * Where to bind, as a pure decision (IO lives in startMcpRelay).
 *
 * Bind the docker-bridge IP (what `host.docker.internal` reaches, e.g.
 * 172.17.0.1), never 0.0.0.0, which would also expose the relay on the tailnet.
 * With no docker0 IP (macOS Docker Desktop, custom nets) REFUSE rather than
 * guess, like every other credential path here fails closed; the operator
 * names the interface with WEBCHAT_MCP_RELAY_HOST.
 */
export function resolveRelayBindHost(explicit: string | undefined, bridgeIp: string | null): RelayBind {
  const named = (explicit ?? '').trim();
  if (named) return { kind: 'bind', host: named };
  if (bridgeIp) return { kind: 'bind', host: bridgeIp };
  return {
    kind: 'refuse',
    reason:
      'no docker0 bridge IP is discoverable, so the container-facing interface is unknown. ' +
      'Set WEBCHAT_MCP_RELAY_HOST to the address agent containers reach as host.docker.internal.',
  };
}

export function startMcpRelay(): void {
  // Exec-relayed agents have no network: central's process dials the relay
  // for them, on loopback — whether or not a docker bridge is discoverable
  // (Node does not list a bridge with nothing attached to it).
  if (execRelayed() && !loopbackServer) {
    loopbackServer = relayHttpServer();
    loopbackServer.listen(MCP_RELAY_PORT, LOOPBACK, () =>
      log.info('MCP auth relay listening', { port: MCP_RELAY_PORT, host: LOOPBACK }),
    );
  }
  if (relayServer) return;
  const bind = resolveRelayBindHost(process.env.WEBCHAT_MCP_RELAY_HOST, dockerBridgeHost());
  if (bind.kind === 'refuse') {
    if (execRelayed()) {
      log.info('MCP auth relay: no docker bridge to listen on; relayed agents reach it on loopback', {
        port: MCP_RELAY_PORT,
      });
      return;
    }
    // Fail closed: MCP servers with host-side auth stay unreachable (their
    // tools simply don't load) rather than the relay listening on every
    // interface. Loud, because the symptom is otherwise a missing toolset.
    log.error(`MCP auth relay NOT started — ${bind.reason}`, { port: MCP_RELAY_PORT });
    return;
  }
  if (bind.host === LOOPBACK && loopbackServer) return;
  relayServer = relayHttpServer();
  relayServer.listen(MCP_RELAY_PORT, bind.host, () => {
    log.info('MCP auth relay listening', { port: MCP_RELAY_PORT, host: bind.host });
  });
}

/**
 * Boot-time start, only if a relay-backed assignment exists (the relay url
 * reaches a container only with a token). A throw leaves it unbound, the safe
 * direction.
 */
export async function startMcpRelayIfAssigned(): Promise<void> {
  let assigned = false;
  try {
    assigned = Boolean(
      await getDb().get(`SELECT 1 AS present FROM webchat_agent_mcp_servers WHERE relay_token IS NOT NULL LIMIT 1`),
    );
  } catch (err) {
    log.warn('MCP auth relay not started — assignment probe failed', { err: String(err) });
    return;
  }
  if (!assigned) {
    log.info('MCP auth relay idle — no server assignments carry a relay token', { port: MCP_RELAY_PORT });
    return;
  }
  startMcpRelay();
}

/** IPv4 of the default docker bridge (`docker0`), which `host.docker.internal`
 *  resolves to for agent containers — or null if there's no such interface. */
function dockerBridgeHost(): string | null {
  for (const a of os.networkInterfaces().docker0 ?? []) {
    if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/**
 * Where central's own process should connect to reach this relay. An agent
 * addresses it as `host.docker.internal:<port>`; the exec relay resolves that
 * name to this address on central.
 */
export function mcpRelayTarget(): { host: string; port: number } {
  if (execRelayed()) return { host: LOOPBACK, port: MCP_RELAY_PORT };
  const host = process.env.WEBCHAT_MCP_RELAY_HOST || dockerBridgeHost() || '127.0.0.1';
  return { host, port: MCP_RELAY_PORT };
}

export function stopMcpRelay(): void {
  // close() alone waits on idle keep-alive sockets: shutdown would hang to SIGKILL.
  for (const server of [relayServer, loopbackServer]) {
    server?.closeAllConnections?.();
    server?.close();
  }
  relayServer = null;
  loopbackServer = null;
}
