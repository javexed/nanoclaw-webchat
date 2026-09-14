/**
 * MCP auth relay — the host-side hop that keeps MCP credentials out of
 * containers (item 7 of the MCP hardening review).
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
 * Listener lifetime: the relay binds only while at least one relay-backed
 * assignment exists — `startMcpRelayIfAssigned()` at boot, and lazily from
 * `ensureRelayToken()` the first time a (group, server) pair is given a token.
 * An install with no authed remote MCP server never opens the port at all,
 * which is most installs. It is not stopped when the last assignment goes
 * away: teardown owns that, and an operator who unassigns mid-session would
 * otherwise silently break a container already holding a relay url.
 */
import http from 'http';
import os from 'os';
import { Readable } from 'stream';

import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { effectiveAuthHeader, parseMcpAuth, refreshOAuthToken } from './mcp-auth.js';
import { getWebchatMcpServer, MCP_RELAY_PORT } from './mcp-registry.js';

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

async function handleRelay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const m = (req.url || '').match(/^\/relay\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
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

  const target = server.url.replace(/\/$/, '') + subPath + query;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';

  const forward = async (): Promise<Response> =>
    fetch(target, {
      method: req.method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req) as unknown as RequestInit['body'], duplex: 'half' } : {}),
      signal: AbortSignal.timeout(10 * 60 * 1000), // long-poll friendly
    } as RequestInit);

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

export type RelayBind = { kind: 'bind'; host: string } | { kind: 'refuse'; reason: string };

/**
 * Where to bind, as a pure decision (IO lives in startMcpRelay).
 *
 * Bind the docker-bridge IP, not 0.0.0.0 — the only legitimate clients are
 * agent containers reaching `host.docker.internal` (→ the default-bridge
 * gateway, e.g. 172.17.0.1 on Linux). 0.0.0.0 additionally exposed the
 * token-gated relay on the tailnet interface.
 *
 * With no docker0 IP discoverable (macOS Docker Desktop, custom nets) we
 * REFUSE rather than falling back to 0.0.0.0: an unknown container network is
 * exactly the case where "listen on everything" is the wrong guess, and every
 * other credential path here fails closed (the OneCLI gateway refuses to spawn
 * without credentials; egress lockdown throws rather than spawning open). The
 * operator names the interface with WEBCHAT_MCP_RELAY_HOST, which is also the
 * override for a non-default container network.
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
  if (relayServer) return;
  const bind = resolveRelayBindHost(process.env.WEBCHAT_MCP_RELAY_HOST, dockerBridgeHost());
  if (bind.kind === 'refuse') {
    // Fail closed: MCP servers with host-side auth stay unreachable (their
    // tools simply don't load) rather than the relay listening on every
    // interface. Loud, because the symptom is otherwise a missing toolset.
    log.error(`MCP auth relay NOT started — ${bind.reason}`, { port: MCP_RELAY_PORT });
    return;
  }
  relayServer = http.createServer((req, res) => {
    void handleRelay(req, res).catch((err) => {
      log.error('MCP relay handler threw', { err });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  relayServer.on('error', (err) => log.error('MCP relay listener error', { err: String(err) }));
  relayServer.listen(MCP_RELAY_PORT, bind.host, () => {
    log.info('MCP auth relay listening', { port: MCP_RELAY_PORT, host: bind.host });
  });
}

/**
 * Boot-time start: bind only if a relay-backed assignment already exists.
 * Nothing can legitimately dial the relay before one does — the url only
 * reaches a container through `mcpServerToConfig`, which needs a relay token.
 * A throw here (table absent on a part-migrated install) leaves it unbound,
 * which is the safe direction: the feature is unused in that state anyway.
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

export function stopMcpRelay(): void {
  // close() alone waits for idle keep-alive sockets — a single lingering
  // client (an MCP connection, a stray probe) turns shutdown into a 90s
  // SIGKILL and an "unclean shutdown" mark for the circuit breaker.
  relayServer?.closeAllConnections?.();
  relayServer?.close();
  relayServer = null;
}
