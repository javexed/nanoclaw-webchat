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
import { sessionDir } from '../../session-manager.js';
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
/** Which session calls: its key file, in its directory (/workspace in its container), and the header that carries it. */
export const SESSION_KEY_FILE = '.laptop-session';
const SESSION_HEADER = 'x-nanoclaw-session';
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
/**
 * How long Claude Code waits for the laptop server to connect. The machine
 * takes its copy of the project on the first request, which is that
 * connection: a large tree took 36 s, past the 30 s default, and the agent
 * then ran with no laptop tools for the whole session.
 */
export const LAPTOP_CONNECT_TIMEOUT_MS = '180000';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// ── the group's configuration ─────────────────────────────────────────────────

function settingsFile(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'settings.json');
}

/**
 * Add or remove our entries in the group's Claude settings — the deny list and
 * the MCP connect timeout — leaving any others alone.
 */
function setDenied(agentGroupId: string, on: boolean): void {
  const file = settingsFile(agentGroupId);
  let settings: { permissions?: { deny?: string[] }; env?: Record<string, string> } & Record<string, unknown> = {};
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
  const env = { ...(settings.env ?? {}) };
  if (on) env.MCP_TIMEOUT = LAPTOP_CONNECT_TIMEOUT_MS;
  else if (env.MCP_TIMEOUT === LAPTOP_CONNECT_TIMEOUT_MS) delete env.MCP_TIMEOUT;
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
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
const fs = require('fs');
const sessionKey = () => { try { return fs.readFileSync(process.env.NANOCLAW_LAPTOP_SESSION_FILE || '', 'utf8').trim(); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (line, message) => {
  let id; try { id = JSON.parse(line).id; } catch {}
  return id === undefined || id === null ? null : JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } });
};
const post = async (line) => {
  const deadline = Date.now() + 60000;
  for (let wait = 200; ; wait = Math.min(wait * 2, 2000)) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-nanoclaw-relay': token, 'x-nanoclaw-session': sessionKey() }, body: line });
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
        NANOCLAW_LAPTOP_SESSION_FILE: `/workspace/${SESSION_KEY_FILE}`,
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
  await ensureSessionKeys(agentGroupId);
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
 * upgrade may ship new tools instructions or settings: each placed group's are refreshed.
 */
export async function startRelayForToolsPlacements(): Promise<void> {
  const placements = await listPlacements();
  if (placements.length) startMcpRelay();
  for (const p of placements) {
    try {
      if (p.mode === 'tools' && p.tools_token) {
        // The server entry too: a newer proxy (what it sends) reaches the next spawn.
        await setMcpServer(p.agent_group_id, p.tools_token);
        await ensureSessionKeys(p.agent_group_id);
        setDenied(p.agent_group_id, true);
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

// ── attachments: served here, not by the machine ─────────────────────────────

/**
 * A file the developer attaches in chat is stored by central in the session's
 * inbox (/workspace/inbox in the agent's container). The agent's own Read is
 * denied (it would act on central) and the machine's Read reaches the project
 * only, so without this the agent could not open an attachment at all.
 */
export const ATTACHMENT_TOOL = {
  name: 'ReadAttachment',
  description:
    'Reads a file the developer attached to a chat message: the /workspace/inbox/... path the message names. Text comes numbered (cat -n style; long files: pass offset and limit); images come as images. For files in the project, use Read.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The attachment path, e.g. /workspace/inbox/<id>/<file name>' },
      offset: { type: 'number', description: 'Line number to start from (1-based)' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['file_path'],
  },
};
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_DEFAULT_LINES = 2000;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

type ToolContent = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
const toolError = (text: string): { content: ToolContent; isError: true } => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/** Where an open fd actually points: /proc/self/fd on Linux, else the path it was opened by. */
function fdRealPath(fd: number, opened: string): string {
  try {
    return fs.realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    return fs.realpathSync(opened);
  }
}

// ── which session is calling ─────────────────────────────────────────────────
//
// A placement token names the group, and every session of the group sends the
// same one. An attachment belongs to one session (one room or thread), so the
// proxy also sends its session's key: a random value central writes in the
// session's own directory, which only that session's container mounts
// (/workspace). ReadAttachment reads that session's inbox and no other.

/** Give each session of a placed group a key, before its container starts (idempotent). */
export async function ensureSessionKeys(agentGroupId: string): Promise<void> {
  for (const s of await getSessionsByAgentGroup(agentGroupId)) {
    const dir = sessionDir(agentGroupId, s.id);
    const file = path.join(dir, SESSION_KEY_FILE);
    try {
      if (fs.existsSync(file)) continue;
      fs.mkdirSync(dir, { recursive: true });
      // 0600: a root host hands the session directory to the container's user at spawn.
      fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST')
        log.warn('Laptop tools: could not write a session key', { agentGroupId, sessionId: s.id, err });
    }
  }
}

/** The session of the group whose key this is, or null. */
async function callingSession(agentGroupId: string, key: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(key)) return null;
  const given = Buffer.from(key);
  for (const s of await getSessionsByAgentGroup(agentGroupId)) {
    let stored: Buffer;
    try {
      stored = Buffer.from(fs.readFileSync(path.join(sessionDir(agentGroupId, s.id), SESSION_KEY_FILE), 'utf8').trim());
    } catch {
      continue;
    }
    if (stored.length === given.length && crypto.timingSafeEqual(stored, given)) return s.id;
  }
  return null;
}

/**
 * The attachment `filePath` names, opened, in the calling session's inbox, or null. Never outside
 * it: the check is made on the open fd, so a path swapped after it cannot redirect the read.
 */
function attachmentFile(
  agentGroupId: string,
  sessionId: string,
  filePath: string,
): { fd: number; file: string } | null {
  const rel = filePath
    .replace(/\\/g, '/')
    .replace(/^\/workspace\/inbox\//, '')
    .replace(/^inbox\//, '');
  if (!rel || rel.startsWith('/') || rel.split('/').some((seg) => seg === '..' || seg === '')) return null;
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const inbox = path.join(sessionDir(agentGroupId, sessionId), 'inbox');
  const file = path.join(inbox, rel);
  let root: string;
  let fd: number;
  try {
    root = fs.realpathSync(inbox);
    fd = fs.openSync(file, flags);
  } catch {
    return null;
  }
  try {
    const real = fdRealPath(fd, file);
    if (real.startsWith(root + path.sep) && fs.fstatSync(fd).isFile()) return { fd, file: real };
  } catch {
    // gone or unreadable
  }
  fs.closeSync(fd);
  return null;
}

export async function readAttachment(
  agentGroupId: string,
  sessionKey: string,
  input: Record<string, unknown>,
): Promise<{ content: ToolContent; isError?: true }> {
  const filePath = String(input.file_path ?? '');
  const sessionId = await callingSession(agentGroupId, sessionKey);
  if (!sessionId)
    return toolError(
      'Attachments cannot be read from this session yet: it started before they were tied to their session. Ask the developer to restart the session.',
    );
  const opened = attachmentFile(agentGroupId, sessionId, filePath);
  if (!opened) return toolError(`No attachment at ${filePath}: give the /workspace/inbox/... path the message names.`);
  try {
    return readOpenAttachment(opened.fd, opened.file, input);
  } finally {
    fs.closeSync(opened.fd);
  }
}

function readOpenAttachment(
  fd: number,
  file: string,
  input: Record<string, unknown>,
): { content: ToolContent; isError?: true } {
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(Math.min(size, 8192));
  fs.readSync(fd, head, 0, head.length, 0);
  const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (mime) {
    if (size > ATTACHMENT_IMAGE_MAX_BYTES)
      return toolError(`${path.basename(file)} is an image over ${ATTACHMENT_IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
    return { content: [{ type: 'image', data: fs.readFileSync(fd).toString('base64'), mimeType: mime }] };
  }
  if (head.includes(0))
    return toolError(`${path.basename(file)} is a binary file (${size} bytes); it cannot be read as text.`);
  if (size > ATTACHMENT_MAX_BYTES)
    return toolError(`${path.basename(file)} is over ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`);
  const lines = fs.readFileSync(fd, 'utf8').split('\n');
  const start = Math.max(1, Math.floor(Number(input.offset) || 1));
  const count = Math.max(1, Math.floor(Number(input.limit) || ATTACHMENT_DEFAULT_LINES));
  const shown = lines.slice(start - 1, start - 1 + count);
  const more = start - 1 + shown.length < lines.length;
  const text =
    shown.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join('\n') +
    (more ? `\n… ${lines.length - (start - 1 + shown.length)} more lines: pass offset ${start + shown.length}.` : '');
  return { content: [{ type: 'text', text }] };
}

/**
 * The tools each machine last listed. The machine takes its copy of the
 * project when asked for the list, which can take longer than the agent waits
 * for its tools; the list itself is fixed per extension version. So once a
 * machine has answered, the list is answered at once from here, and the
 * machine's copy goes on: its tool calls queue behind it there.
 */
const listedTools = new Map<string, unknown[]>();
const LIST_TIMEOUT_MS = 150_000;

export function __resetListedToolsForTest(): void {
  listedTools.clear();
}

async function answer(
  msg: JsonRpc,
  placement: RunnerPlacementRow,
  sessionKey: string,
): Promise<Record<string, unknown> | null> {
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
    case 'tools/list': {
      const asked = runnerRequest(placement.fingerprint, 'tools.list', scope, LIST_TIMEOUT_MS).then((r) => {
        const tools = Array.isArray(r.tools) ? r.tools : [];
        listedTools.set(placement.fingerprint, tools);
        return tools;
      });
      const failed = (err: unknown) =>
        log.warn('Laptop tools: the machine could not list its tools', {
          agentGroupId: scope.agentGroupId,
          err: String(err),
        });
      const known = listedTools.get(placement.fingerprint);
      if (known) {
        asked.catch(failed);
        return ok({ tools: [...known, ATTACHMENT_TOOL] });
      }
      try {
        return ok({ tools: [...(await asked), ATTACHMENT_TOOL] });
      } catch (err) {
        failed(err);
        // Attachments live here: readable even while the machine is away.
        return ok({ tools: [ATTACHMENT_TOOL] });
      }
    }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      if (name === ATTACHMENT_TOOL.name)
        return ok(
          await readAttachment(
            placement.agent_group_id,
            sessionKey,
            (msg.params?.arguments ?? {}) as Record<string, unknown>,
          ),
        );
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
  const sessionKey = String(req.headers[SESSION_HEADER] ?? '');
  const answers = (await Promise.all(messages.map((m) => answer(m, placement, sessionKey)))).filter(
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
