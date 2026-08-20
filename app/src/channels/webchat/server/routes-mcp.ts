// ── MCP server routes ────────────────────────────────────────────────────────
// Every handler behind the MCP panel: the built-in registry source, CRUD over
// user-added servers, catalog listing and the reachability probe, plus the
// catalog cache and body parser only these handlers use.
//
// The symbols the agent-side handlers in server.ts also touch live in
// server/mcp-registry.ts — see the note there.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { getDb } from '../../../db/connection.js';
import { validateMcpServerName } from '../../../mcp-server-config.js';
import { isSourceDisabled, setSourceDisabled } from '../db.js';
import { finishOAuthFlow, startOAuthFlow } from '../mcp-auth.js';
import { checkMcpServer } from '../mcp-health.js';
import { probeMcpEndpoint } from '../mcp-probe.js';
import {
  createWebchatMcpServer,
  deleteWebchatMcpServer,
  getAgentsAssignedToMcpServer,
  getWebchatMcpServer,
  getWebchatMcpServerByName,
  listWebchatMcpServers,
  pinMcpToolSurface,
  setMcpServerAuth,
  setMcpServerDrift,
  setMcpServerEnabledTools,
  syncAgentMcpConfig,
  updateWebchatMcpServer,
} from '../mcp-registry.js';
import type { WebchatMcpServerInput } from '../mcp-registry.js';
import { isGlobalAdmin, isOwner } from '../roles.js';
import { MCP_REGISTRY_ID, mcpRegistryRemovedKey, mcpServerForUI, reloadAgentMcpServers } from './mcp-registry.js';
import type { McpServerForUI } from './mcp-registry.js';
import type { RouteCtx } from '../server.js';

// MCP registry is admin-only (scoped admin or higher) — end to end.
export async function rMcpServersGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, listMcpServersForUI());
}

export async function rMcpServersPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return createMcpServerHandler(req, res);
}

// Read-only discovery over the public MCP registry. Admin-gated like the rest of
// the MCP surface; adds no write path (a row prefills the existing add form, so
// every server still goes through probe → create).
export async function rMcpSourcesGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return json(res, 200, {
    sources: [
      {
        ...MCP_REGISTRY_SOURCE,
        disabled: isSourceDisabled(MCP_REGISTRY_ID),
        removed: isSourceDisabled(mcpRegistryRemovedKey()),
      },
    ],
  });
}

export async function rMcpSourcePut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const id = decodeURIComponent(m[1]);
  if (id !== MCP_REGISTRY_ID) return json(res, 404, { error: 'Unknown source' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let disabled = false;
  try {
    disabled = !!(JSON.parse(raw) as { disabled?: unknown }).disabled;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  setSourceDisabled(MCP_REGISTRY_ID, disabled);
  return json(res, 200, { ok: true, disabled });
}

// Full removal (parity with skill sources' Remove). Stronger than disable:
// the row leaves Settings save for a one-line restore, and the catalog is
// gone server-side. Restore = POST on the same path.
export async function rMcpSourceDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (decodeURIComponent(m[1]) !== MCP_REGISTRY_ID) return json(res, 404, { error: 'Unknown source' });
  setSourceDisabled(mcpRegistryRemovedKey(), true);
  return json(res, 200, { ok: true, removed: true });
}

export async function rMcpSourcePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  // Restore a removed source (clears the disabled flag too — a restore
  // should come back usable, not resurrect half-off).
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  if (decodeURIComponent(m[1]) !== MCP_REGISTRY_ID) return json(res, 404, { error: 'Unknown source' });
  setSourceDisabled(mcpRegistryRemovedKey(), false);
  setSourceDisabled(MCP_REGISTRY_ID, false);
  return json(res, 200, { ok: true, removed: false });
}

export async function rMcpCatalogGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  return mcpCatalogHandler(res, url.searchParams.get('q') || '');
}

export async function rMcpServersProbePost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return probeMcpServerHandler(req, res);
}

// OAuth callback: the admin's browser lands here from the authorization
// server. Auth = whois like everything else, plus the single-use state.
export async function rMcpServersOauthCallbackGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!code || !state) return json(res, 400, { error: 'Missing code/state' });
  try {
    const { serverId } = await finishOAuthFlow(state, code);
    const server = getWebchatMcpServer(serverId);
    if (server) {
      // Re-sync every assigned agent onto the relay URL now that auth exists.
      for (const gid of getAgentsAssignedToMcpServer(serverId)) {
        syncAgentMcpConfig(gid, server, true);
        reloadAgentMcpServers(gid);
      }
      void checkMcpServer(server).catch(() => {});
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:2rem">✅ MCP server connected — you can close this tab and return to NanoClaw.</body>',
    );
    return;
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Failed</title><body style="font-family:system-ui;padding:2rem">OAuth failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}</body>`,
    );
    return;
  }
}

export async function rMcpOauthStartPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let staticClient: { client_id: string; client_secret?: string } | undefined;
  try {
    const b = JSON.parse(raw || '{}') as { client_id?: string; client_secret?: string };
    if (b.client_id) staticClient = { client_id: String(b.client_id), client_secret: b.client_secret };
  } catch {
    /* empty body is fine */
  }
  const host = String(req.headers.host || '');
  if (!host) return json(res, 400, { error: 'Missing Host header' });
  const redirectUri = `https://${host}/api/mcp-servers/oauth/callback`;
  try {
    const authorizeUrl = await startOAuthFlow(decodeURIComponent(m[1]), redirectUri, staticClient);
    return json(res, 200, { authorizeUrl });
  } catch (err) {
    return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Re-approve a drifted tool surface: pin what the server exposes NOW.
export async function rMcpRepinPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const server = await getWebchatMcpServer(decodeURIComponent(m[1]));
  if (!server) return json(res, 404, { error: 'MCP server not found' });
  if (server.transport === 'stdio' || !server.url) return json(res, 400, { error: 'Only remote servers are pinned' });
  setMcpServerDrift(server.id, null);
  await getDb().run(`UPDATE webchat_mcp_servers SET pinned_tools = NULL WHERE id = ?`, server.id);
  const health = await checkMcpServer(getWebchatMcpServer(server.id)!); // re-probe pins the current surface
  return json(res, 200, { ok: true, health });
}

// Tool allowlist for a server (null/empty = all tools). Flows into each
// assigned agent's container config → the SDK's allowedTools filter.
export async function rMcpToolsPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const server = await getWebchatMcpServer(decodeURIComponent(m[1]));
  if (!server) return json(res, 404, { error: 'MCP server not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let enabled: string[] | null = null;
  try {
    const b = JSON.parse(raw) as { enabled?: unknown };
    if (Array.isArray(b.enabled)) enabled = b.enabled.map(String).slice(0, 500);
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  setMcpServerEnabledTools(server.id, enabled && enabled.length ? enabled : null);
  const updated = getWebchatMcpServer(server.id)!;
  for (const gid of getAgentsAssignedToMcpServer(server.id)) {
    syncAgentMcpConfig(gid, updated, true);
    reloadAgentMcpServers(gid);
  }
  return json(res, 200, { ok: true });
}

// Host-side credential for a server: {token} sets a bearer secret, null
// clears. Never echoed back; containers switch to the relay on next sync.
export async function rMcpAuthPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const server = await getWebchatMcpServer(decodeURIComponent(m[1]));
  if (!server) return json(res, 404, { error: 'MCP server not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let token: string | null = null;
  try {
    const b = JSON.parse(raw) as { token?: unknown };
    token = typeof b.token === 'string' && b.token.trim() ? b.token.trim() : null;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  setMcpServerAuth(server.id, token ? { kind: 'bearer', token } : null);
  const updated = getWebchatMcpServer(server.id)!;
  for (const gid of getAgentsAssignedToMcpServer(server.id)) {
    syncAgentMcpConfig(gid, updated, true);
    reloadAgentMcpServers(gid);
  }
  return json(res, 200, { ok: true, hasAuth: !!token });
}

export async function rMcpServerIdPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return updateMcpServerHandler(req, res, decodeURIComponent(m[1]));
}

export async function rMcpServerIdDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, url } = ctx;
  return deleteMcpServerHandler(res, decodeURIComponent(m[1]), url.searchParams.get('force') === '1');
}

export async function listMcpServersForUI(): Promise<McpServerForUI[]> {
  return (await listWebchatMcpServers()).map(mcpServerForUI);
}

/** Parse + validate a registry create/update body into a WebchatMcpServerInput. */
export function parseMcpServerBody(body: Record<string, unknown>): WebchatMcpServerInput {
  const name = validateMcpServerName(body.name);
  const transport = body.transport;
  if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
    throw new Error('transport must be "stdio" | "sse" | "http"');
  }
  const input: WebchatMcpServerInput = { name, transport };
  if (transport === 'stdio') {
    if (typeof body.command !== 'string' || !body.command.trim()) throw new Error('command required for stdio');
    input.command = body.command.trim();
    if (Array.isArray(body.args)) input.args = body.args.map(String);
    if (body.env && typeof body.env === 'object') input.env = body.env as Record<string, string>;
  } else {
    if (typeof body.url !== 'string' || !body.url.trim()) throw new Error('url required for a remote server');
    input.url = body.url.trim().replace(/\/+$/, '');
    if (body.headers && typeof body.headers === 'object') input.headers = body.headers as Record<string, string>;
  }
  if (typeof body.instructions === 'string' && body.instructions.trim()) input.instructions = body.instructions.trim();
  return input;
}

export async function createMcpServerHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let input: WebchatMcpServerInput;
  try {
    input = parseMcpServerBody(body);
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : 'Invalid MCP server' });
  }
  // Names key container_configs.mcp_servers (and the SDK's mcp__<name>__* tool
  // prefixes), so they must be unique across the registry.
  if ((await getWebchatMcpServerByName(input.name))) {
    return json(res, 409, { error: `An MCP server named "${input.name}" already exists` });
  }
  const server = await createWebchatMcpServer(input);
  // The add form probes before saving — that probed surface is the operator's
  // approval, so pin it as the drift baseline right here.
  if (Array.isArray(body.tools) && body.tools.length) {
    try {
      pinMcpToolSurface(
        server.id,
        (body.tools as { name?: unknown; description?: unknown }[])
          .filter((t) => typeof t?.name === 'string')
          .map((t) => ({ name: String(t.name), description: String(t.description ?? '') })),
      );
    } catch {
      /* pin is protection, not a gate */
    }
  }
  return json(res, 200, { ok: true, server: mcpServerForUI(server) });
}

export async function updateMcpServerHandler(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const existing = await getWebchatMcpServer(id);
  if (!existing) return json(res, 404, { error: 'MCP server not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  let input: WebchatMcpServerInput;
  try {
    // Merge onto the existing row so a partial body (e.g. rename only) works.
    input = parseMcpServerBody({
      name: body.name ?? existing.name,
      transport: body.transport ?? existing.transport,
      command: body.command ?? existing.command ?? undefined,
      args: body.args ?? (existing.args ? JSON.parse(existing.args) : undefined),
      env: body.env ?? (existing.env ? JSON.parse(existing.env) : undefined),
      url: body.url ?? existing.url ?? undefined,
      headers: body.headers ?? (existing.headers ? JSON.parse(existing.headers) : undefined),
      instructions: body.instructions ?? existing.instructions ?? undefined,
    });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : 'Invalid MCP server' });
  }
  const clash = await getWebchatMcpServerByName(input.name);
  if (clash && clash.id !== id) {
    return json(res, 409, { error: `An MCP server named "${input.name}" already exists` });
  }
  const oldName = existing.name;
  updateWebchatMcpServer(id, input);
  // Re-sync every assigned agent: drop the old key when renamed, upsert the
  // new config, and restart so live containers pick the change up.
  const updated = await getWebchatMcpServer(id);
  for (const agentGroupId of getAgentsAssignedToMcpServer(id)) {
    if (updated && oldName !== updated.name) syncAgentMcpConfig(agentGroupId, { ...updated, name: oldName }, false);
    if (updated) syncAgentMcpConfig(agentGroupId, updated, true);
    reloadAgentMcpServers(agentGroupId);
  }
  return json(res, 200, { ok: true });
}

export async function deleteMcpServerHandler(res: ServerResponse, id: string, force: boolean): Promise<void> {
  const existing = getWebchatMcpServer(id);
  if (!existing) return json(res, 404, { error: 'MCP server not found' });
  const assigned = await getAgentsAssignedToMcpServer(id);
  if (assigned.length > 0 && !force) {
    // Cascade-with-confirmation (mirrors models): surface the impact list so
    // the PWA can prompt before detaching the server from live agents.
    return json(res, 409, {
      error: 'MCP server is attached to agents. Re-request with ?force=1 to detach and delete.',
      assigned_agent_group_ids: assigned,
    });
  }
  for (const agentGroupId of assigned) {
    syncAgentMcpConfig(agentGroupId, existing, false);
  }
  deleteWebchatMcpServer(id);
  for (const agentGroupId of assigned) {
    reloadAgentMcpServers(agentGroupId);
  }
  return json(res, 200, { ok: true, unassigned_count: assigned.length });
}

/**
 * MCP catalog — the official Model Context Protocol registry.
 *
 * Read-only discovery. It NEVER writes: a row just prefills the existing add form,
 * so every server still goes through probe → create, and the catalog adds no new
 * write path to the MCP config.
 *
 * Two classes of entry, and the difference is the whole security story:
 *
 *   remote  — {type, url}. The container dials OUT to a hosted server. No foreign
 *             code runs on this machine.
 *   package — an npm/pypi package run over stdio. Adding one EXECUTES third-party
 *             code inside the agent container, alongside its credentials. Flagged
 *             `runsCode` so the UI can gate it behind an explicit confirm.
 *
 * Trust: there is no "official" tier here. Nothing in the registry is published by
 * Anthropic — and a name match would be actively dangerous, because third parties
 * publish servers *called* things like `anthropic-admin-mcp`. The badge shows the
 * real publisher namespace (the part before the '/') and nothing more.
 */
export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';

export const MCP_REGISTRY_SOURCE = {
  id: MCP_REGISTRY_ID,
  name: 'Model Context Protocol registry',
  url: 'https://registry.modelcontextprotocol.io',
  official: false, // community-published; nobody vets these
};

export interface McpCatalogRow {
  name: string;
  title: string;
  description: string;
  version: string;
  publisher: string;
  kind: 'remote' | 'package';
  runsCode: boolean;
  url?: string;
  transport?: 'http' | 'sse';
  command?: string;
  args?: string[];
  /** Where the operator can go to actually READ this thing before trusting it. */
  repoUrl?: string;
  websiteUrl?: string;
}

export const mcpCatalogCache = new Map<string, { at: number; rows: McpCatalogRow[] }>();

export const MCP_CATALOG_TTL_MS = 5 * 60_000;

/** Compare dotted versions numerically so 1.10.0 beats 1.9.0 (string sort doesn't). */
export function versionGreater(a: string, b: string): boolean {
  const pa = String(a)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** How a package identifier becomes a runnable stdio command. */
export function packageCommand(
  registryType: string,
  identifier: string,
  version?: string,
): { command: string; args: string[] } | null {
  // Pin to the registry entry's immutable version — an unpinned `npx -y pkg`
  // re-resolves LATEST at every container spawn, which is exactly the
  // trusted-package-turns-malicious window (the postmark-mcp pattern). Only
  // pin when the string looks like a real version; the registry accepts any
  // ≤255-char string and a junk pin would break the install loudly.
  const pin = version && /^\d+\.\d+/.test(version) ? version : null;
  if (registryType === 'npm') return { command: 'npx', args: ['-y', pin ? `${identifier}@${pin}` : identifier] };
  if (registryType === 'pypi') return { command: 'uvx', args: [pin ? `${identifier}==${pin}` : identifier] };
  return null; // oci/other — we don't synthesize a command we can't vouch for
}

/** Third-party strings end up in an <a href> — allow http(s) only, nothing else. */
export function safeHttpUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || !u) return undefined;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeMcpRegistry(payload: unknown): McpCatalogRow[] {
  const servers = (payload as { servers?: { server?: Record<string, unknown> }[] })?.servers || [];
  const byName = new Map<string, McpCatalogRow>();
  for (const entry of servers) {
    const s = entry?.server;
    if (!s || typeof s.name !== 'string') continue;
    const name = s.name;
    const version = String(s.version || '0');
    const prev = byName.get(name);
    // The registry lists every published version — keep only the newest.
    if (prev && !versionGreater(version, prev.version)) continue;

    const remotes = (s.remotes as { type?: string; url?: string }[] | undefined) || [];
    const packages = (s.packages as { registryType?: string; identifier?: string }[] | undefined) || [];

    const repo = s.repository as { url?: string } | undefined;
    const base = {
      name,
      title: String(s.title || name.split('/').pop() || name),
      description: String(s.description || ''),
      version,
      publisher: name.includes('/') ? name.split('/')[0] : '',
      // Only ever surface http(s) links — a registry entry is third-party data, and
      // it must not be able to inject a javascript:/data: URL into an <a href>.
      repoUrl: safeHttpUrl(repo?.url),
      websiteUrl: safeHttpUrl(s.websiteUrl),
    };

    // Prefer the remote form when a server offers both — it's the safe one.
    const remote = remotes.find((r) => r.url);
    if (remote?.url) {
      byName.set(name, {
        ...base,
        kind: 'remote',
        runsCode: false,
        url: remote.url,
        // The registry says streamable-http / sse; our config takes http | sse.
        transport: remote.type === 'sse' ? 'sse' : 'http',
      });
      continue;
    }
    const pkg = packages.find((p) => p.identifier && p.registryType);
    if (pkg) {
      const cmd = packageCommand(String(pkg.registryType), String(pkg.identifier), version);
      if (!cmd) continue;
      byName.set(name, { ...base, kind: 'package', runsCode: true, command: cmd.command, args: cmd.args });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function mcpCatalogHandler(res: ServerResponse, q: string): Promise<void> {
  // Switched off in Settings → the catalog is gone, server-side too. Not just
  // hidden in the UI: no request is made to the registry at all.
  if ((await isSourceDisabled(MCP_REGISTRY_ID)) || (await isSourceDisabled(mcpRegistryRemovedKey())))
    return json(res, 200, { servers: [], disabled: true });
  const key = q.trim().toLowerCase();
  const hit = mcpCatalogCache.get(key);
  if (hit && Date.now() - hit.at < MCP_CATALOG_TTL_MS) return json(res, 200, { servers: hit.rows });
  try {
    const target = `${MCP_REGISTRY_URL}?limit=100${key ? `&search=${encodeURIComponent(key)}` : ''}`;
    const r = await fetch(target, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return json(res, 502, { error: `Registry returned ${r.status}` });
    const rows = normalizeMcpRegistry(await r.json());
    mcpCatalogCache.set(key, { at: Date.now(), rows });
    return json(res, 200, { servers: rows });
  } catch (err) {
    return json(res, 502, { error: 'Registry unreachable: ' + (err instanceof Error ? err.message : String(err)) });
  }
}

export async function probeMcpServerHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { url?: unknown; headers?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.url !== 'string' || !body.url.trim()) return json(res, 400, { error: 'url required' });
  const url = body.url.trim();
  if (/\s|[<>]/.test(url)) return json(res, 400, { error: 'url contains invalid characters' });
  // Bare hosts are common ("winbox:8000") — default the scheme to http, the
  // typical case for a LAN/tailnet tool server (https rides through as-is).
  const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  const headers = body.headers && typeof body.headers === 'object' ? (body.headers as Record<string, string>) : {};
  try {
    const result = await probeMcpEndpoint(withScheme, headers);
    return json(res, 200, result);
  } catch (err) {
    // assertSafeOutboundUrl rejections land here — a 400, not a 500: the
    // input was refused, the probe itself didn't break.
    return json(res, 400, { error: err instanceof Error ? err.message : 'Probe failed' });
  }
}

export function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
