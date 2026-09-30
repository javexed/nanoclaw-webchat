// ── Laptop tools: the agent on central, the project on the developer's machine ──
//
// A group placed on a runner machine runs its agent on central, like any
// local group, and works on the developer's project through
// tools the VS Code extension serves on that machine (vscode-extension/src/
// laptop-tools.ts): Read, Edit, Write, Glob, Grep and read-only git, confined
// to a proposal copy the developer reviews and applies. Nothing on the machine
// runs a command the agent chose, and the machine needs no container.
//
// This side:
//   - an MCP endpoint on the relay port, /laptop: the group's agent container
//     reaches it as `host.docker.internal:<relay port>/laptop` with the
//     placement's token, and each call is forwarded to the machine over the
//     runner socket;
//   - the group's configuration while it is placed: that MCP server, Claude's
//     own shell and file tools denied (so the agent cannot work on a copy on
//     central by mistake — denied tools are not even offered), and standing
//     instructions that say where the project is (the group's own are kept
//     aside and restored when the placement is removed).
import crypto from 'crypto';
import fs from 'fs';
import type http from 'http';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, INSTALL_SLUG } from '../../config.js';
import { killContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { PERSONA_PREPEND_FILE } from '../../group-persona.js';
import { log } from '../../log.js';
import { MCP_RELAY_PORT, registerRelayRoute, startMcpRelay } from './mcp-relay.js';
import { runnerToolsPersona } from './runner-persona.js';
import {
  getMachine,
  getPlacementByToolsToken,
  listPlacements,
  setPlacement,
  type RunnerPlacementRow,
} from './runner-registry.js';
import { RunnerRequestError, runnerRequest } from './runner-transport.js';

export const LAPTOP_SERVER = 'laptop';
export const LAPTOP_PATH = '/laptop';
const TOKEN_HEADER = 'x-nanoclaw-relay';
/** Claude's built-ins that would act on central instead of the developer's project. */
export const DENIED_BUILTINS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
  'NotebookEdit',
];
const CALL_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export const newToolsToken = (): string => crypto.randomBytes(32).toString('base64url');

// ── the group's configuration ─────────────────────────────────────────────────

function settingsFile(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'settings.json');
}

/** Add or remove our entries in the group's Claude settings deny list, leaving any others alone. */
function setDenied(agentGroupId: string, on: boolean): void {
  const file = settingsFile(agentGroupId);
  let settings: { permissions?: { deny?: string[] } } & Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof settings;
  } catch {
    if (!on) return;
  }
  const deny = new Set(settings.permissions?.deny ?? []);
  for (const t of DENIED_BUILTINS) {
    if (on) deny.add(t);
    else deny.delete(t);
  }
  settings.permissions = { ...(settings.permissions ?? {}), deny: [...deny] };
  if (!settings.permissions.deny?.length) delete settings.permissions.deny;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * The laptop server as the agent's Claude Code sees it: a stdio server run
 * inline in its container (no file), forwarding each JSON-RPC message to
 * /laptop on the relay. Not the http transport directly: Claude Code connects
 * its MCP servers the moment the agent starts, before central has attached
 * an exec-relayed container's forwarder (about a second later), and a refused
 * connection there marks the server failed for the whole session. A stdio
 * server starts at once and this one retries until the relay answers, which
 * also rides out the gap while central restarts and re-attaches.
 */
export const LAPTOP_PROXY = `
const url = process.env.NANOCLAW_LAPTOP_URL, token = process.env.NANOCLAW_LAPTOP_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (line, message) => {
  let id; try { id = JSON.parse(line).id; } catch {}
  return id === undefined || id === null ? null : JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } });
};
const post = async (line) => {
  const deadline = Date.now() + 60000;
  for (let wait = 200; ; wait = Math.min(wait * 2, 2000)) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-nanoclaw-relay': token }, body: line });
      if (r.status === 202) return null;
      const text = await r.text();
      return r.ok ? text : fail(line, 'laptop tools: HTTP ' + r.status + ' ' + text.slice(0, 200));
    } catch (e) {
      if (Date.now() > deadline) return fail(line, 'laptop tools unreachable: ' + (e && e.message ? e.message : e));
      await sleep(wait);
    }
  }
};
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\\n')) >= 0; ) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) void post(line).then((out) => { if (out) process.stdout.write(out.trim() + '\\n'); });
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 100));
`;

async function setMcpServer(agentGroupId: string, token: string | null): Promise<void> {
  const row = await getContainerConfig(agentGroupId);
  if (!row) return;
  let servers: Record<string, unknown> = {};
  try {
    servers = (JSON.parse(row.mcp_servers || '{}') as Record<string, unknown>) ?? {};
  } catch {
    /* unreadable: start over with ours alone */
  }
  if (token) {
    servers[LAPTOP_SERVER] = {
      command: 'bun',
      args: ['-e', LAPTOP_PROXY],
      env: {
        NANOCLAW_LAPTOP_URL: `http://host.docker.internal:${MCP_RELAY_PORT}${LAPTOP_PATH}`,
        NANOCLAW_LAPTOP_TOKEN: token,
        // Straight to central's relay, never through the credential gateway's proxy.
        NO_PROXY: 'host.docker.internal,localhost,127.0.0.1',
        no_proxy: 'host.docker.internal,localhost,127.0.0.1',
      },
    };
  } else if (!(LAPTOP_SERVER in servers)) return;
  else delete servers[LAPTOP_SERVER];
  await updateContainerConfigJson(agentGroupId, 'mcp_servers', servers);
}

/** Where a group's own instructions wait while it is placed on a machine (the name earlier versions wrote). */
export const CONTAINER_PERSONA_BACKUP = 'instructions.prepend.container.md';
/** The hash of the tools text last written: that text, in any shipped version, is ours to replace. */
export const TOOLS_PERSONA_WRITTEN = 'instructions.prepend.tools.sha256';

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/**
 * A placed group needs its own standing instructions: where the project is
 * and that it can only be read and changed, not run. Placing keeps whatever
 * the group had (any shipped version, or an admin's own) aside and writes the
 * tools text; removing the placement restores it — unless the tools text was
 * edited meanwhile, which is then kept and the backup left for an admin. A
 * tools text we wrote, in an older version, is refreshed in place.
 */
async function setPersona(agentGroupId: string, placement: RunnerPlacementRow, tools: boolean): Promise<void> {
  const group = await getAgentGroup(agentGroupId);
  const machine = await getMachine(placement.fingerprint);
  if (!group || !machine) return;
  const label = machine.hostname || placement.fingerprint.slice(0, 12);
  const owner = machine.user_id.replace(/^webchat:/, '');
  const dir = path.join(GROUPS_DIR, group.folder);
  const file = path.join(dir, PERSONA_PREPEND_FILE);
  const backup = path.join(dir, CONTAINER_PERSONA_BACKUP);
  const toolsText = `${runnerToolsPersona(label, owner).trimEnd()}\n`;
  const written = path.join(dir, TOOLS_PERSONA_WRITTEN);
  const read = (f: string): string | null => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };
  const now = read(file);
  const recorded = read(written)?.trim();
  const hasBackup = fs.existsSync(backup);
  // Ours: the current text, the one we last wrote, or — written before the
  // hash was kept — an earlier shipped version, known by its opening line.
  const ours =
    now !== null &&
    (now === toolsText ||
      (recorded ? recorded === sha256(now) : hasBackup && now.split('\n')[0] === toolsText.split('\n')[0]));
  if (tools) {
    if (now === toolsText && recorded === sha256(toolsText)) return;
    if (now !== null && !ours) {
      if (hasBackup) {
        log.info('Laptop tools: the tools-mode instructions were edited; kept', { agentGroupId });
        return;
      }
      fs.writeFileSync(backup, now);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, toolsText);
    fs.writeFileSync(written, `${sha256(toolsText)}\n`);
    return;
  }
  if (!hasBackup) return;
  if (now !== null && !ours) {
    log.info('Laptop tools: the tools-mode instructions were edited; kept, with the earlier ones left beside them', {
      agentGroupId,
      backup: CONTAINER_PERSONA_BACKUP,
    });
    return;
  }
  fs.writeFileSync(file, fs.readFileSync(backup, 'utf8'));
  fs.rmSync(backup, { force: true });
  fs.rmSync(written, { force: true });
}

/** Bring a placed group in line: the laptop MCP server, the deny list, the tools instructions. */
export async function applyPlacementMode(agentGroupId: string, placement: RunnerPlacementRow): Promise<void> {
  if (!placement.tools_token) return;
  startMcpRelay();
  await setMcpServer(agentGroupId, placement.tools_token);
  setDenied(agentGroupId, true);
  await setPersona(agentGroupId, placement, true);
  log.info('Laptop tools: placement applied', { agentGroupId });
}

/**
 * The placement is gone (removed, the machine revoked or rejected): all three
 * undone, the group's own instructions back. `prior` is the placement that
 * was; without it only the configuration is undone.
 */
export async function releasePlacement(agentGroupId: string, prior: RunnerPlacementRow | null): Promise<void> {
  await setMcpServer(agentGroupId, null);
  setDenied(agentGroupId, false);
  if (prior) await setPersona(agentGroupId, prior, false);
  log.info('Laptop tools: placement released', { agentGroupId });
}

/**
 * At startup: sessions that survive a restart are adopted, never prepared,
 * so the relay their laptop tools go through must be up before any spawn.
 * A placement from before the laptop container was retired ('container'
 * mode, no token) becomes a tools placement here, with its configuration —
 * otherwise its group would run on central with no way to the project. And an
 * upgrade may ship new tools instructions: each placed group's are refreshed.
 */
export async function startRelayForToolsPlacements(): Promise<void> {
  const placements = await listPlacements();
  if (placements.length) startMcpRelay();
  for (const p of placements) {
    try {
      if (p.mode === 'tools' && p.tools_token) {
        await setPersona(p.agent_group_id, p, true);
        continue;
      }
      const converted = await setPlacement(p.agent_group_id, p.fingerprint, p.created_by, p.created_at);
      await applyPlacementMode(p.agent_group_id, converted);
      log.info('Laptop tools: a container placement now uses the laptop tools', { agentGroupId: p.agent_group_id });
    } catch (err) {
      log.warn('Laptop tools: could not bring a placement up to date', { agentGroupId: p.agent_group_id, err });
    }
  }
}

/**
 * Stop the agents of every group placed on a machine, here on central (Stop
 * all from its editor, or the machine revoked). Returns the sessions asked to
 * stop; a session with no running container is left as it is.
 */
export async function stopAgentsPlacedOn(fingerprint: string, reason: string): Promise<number> {
  let n = 0;
  for (const p of await listPlacements()) {
    if (p.fingerprint !== fingerprint) continue;
    for (const s of await getSessionsByAgentGroup(p.agent_group_id)) {
      killContainer(s.id, reason);
      n++;
    }
  }
  return n;
}

// ── the MCP endpoint ─────────────────────────────────────────────────────────

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

const unreachable = (err: unknown): string =>
  err instanceof RunnerRequestError && (err.code === 'not-connected' || err.code === 'disconnected')
    ? "The developer's machine is not connected to NanoClaw right now, so the project cannot be reached. Say so and stop; do not guess at its contents."
    : `The developer's machine did not answer: ${String((err as Error)?.message ?? err).slice(0, 300)}`;

async function answer(msg: JsonRpc, placement: RunnerPlacementRow): Promise<Record<string, unknown> | null> {
  if (msg.id === undefined || msg.id === null) return null; // a notification
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const scope = { installSlug: INSTALL_SLUG, agentGroupId: placement.agent_group_id };
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: LAPTOP_SERVER, version: '1.0.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      try {
        const r = await runnerRequest(placement.fingerprint, 'tools.list', scope, 30_000);
        return ok({ tools: Array.isArray(r.tools) ? r.tools : [] });
      } catch (err) {
        log.warn('Laptop tools: the machine could not list its tools', {
          agentGroupId: scope.agentGroupId,
          err: String(err),
        });
        return ok({ tools: [] });
      }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      try {
        const r = await runnerRequest(
          placement.fingerprint,
          'tools.call',
          { ...scope, name, input: msg.params?.arguments ?? {} },
          CALL_TIMEOUT_MS,
        );
        return ok({ content: [{ type: 'text', text: String(r.text ?? '') }], ...(r.isError ? { isError: true } : {}) });
      } catch (err) {
        return ok({ content: [{ type: 'text', text: unreachable(err) }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

/** POST /laptop: one JSON-RPC message or a batch, answered as JSON (the Streamable HTTP transport without SSE). */
export async function serveLaptopTools(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const token = String(req.headers[TOKEN_HEADER] ?? '');
  const placement = token ? await getPlacementByToolsToken(token) : undefined;
  if (!placement) {
    res.writeHead(403).end('laptop tools token invalid');
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(200).end();
    return;
  }
  if (req.method !== 'POST') {
    // No server-initiated stream: the client falls back to plain request/response.
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  const raw = await readBody(req);
  let body: JsonRpc | JsonRpc[];
  try {
    body = JSON.parse(raw ?? '') as JsonRpc | JsonRpc[];
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
    return;
  }
  const batch = Array.isArray(body);
  const messages: JsonRpc[] = Array.isArray(body) ? body : [body];
  const answers = (await Promise.all(messages.map((m) => answer(m, placement)))).filter(
    (a): a is Record<string, unknown> => a !== null,
  );
  if (!answers.length) {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(batch ? answers : answers[0]));
}

registerRelayRoute(LAPTOP_PATH, serveLaptopTools);
