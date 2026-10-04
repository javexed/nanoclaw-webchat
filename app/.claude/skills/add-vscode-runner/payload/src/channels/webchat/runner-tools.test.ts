import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const base = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'runner-tools-'));
  return { base, data: `${base}/data`, groups: `${base}/groups` };
});
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  DATA_DIR: dirs.data,
  GROUPS_DIR: dirs.groups,
  INSTALL_SLUG: 'inst',
}));

const { placements, configs, startMcpRelay, runnerRequest, killContainer, sessions } = vi.hoisted(() => ({
  placements: new Map<string, Record<string, unknown>>(),
  configs: new Map<string, string>(),
  startMcpRelay: vi.fn(),
  runnerRequest: vi.fn(),
  killContainer: vi.fn(),
  sessions: new Map<string, Array<{ id: string }>>(),
}));
vi.mock('./runner-registry.js', () => ({
  getPlacementByToolsToken: async (t: string) =>
    [...placements.values()].find((p) => p.tools_token === t && p.mode === 'tools'),
  getMachine: async () => ({ hostname: 'devbox', user_id: 'webchat:jane@example.com' }),
  listPlacements: async () => [...placements.values()],
  setPlacement: async (id: string, fingerprint: string, by: string, now: number) => {
    const row = {
      agent_group_id: id,
      fingerprint,
      slots_json: '{}',
      created_by: by,
      created_at: now,
      mode: 'tools',
      tools_token: 'n'.repeat(43),
    };
    placements.set(id, row);
    return row;
  },
}));
vi.mock('../../container-runner.js', () => ({ killContainer }));
vi.mock('../../db/sessions.js', () => ({ getSessionsByAgentGroup: async (id: string) => sessions.get(id) ?? [] }));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: async (id: string) => (configs.has(id) ? { mcp_servers: configs.get(id) } : undefined),
  updateContainerConfigJson: async (id: string, _col: string, v: unknown) => void configs.set(id, JSON.stringify(v)),
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: async (id: string) => ({ id, folder: `folder-${id}` }) }));
vi.mock('./mcp-relay.js', () => ({ MCP_RELAY_PORT: 3302, registerRelayRoute: vi.fn(), startMcpRelay }));
vi.mock('./runner-transport.js', async (orig) => ({
  ...(await orig<object>()),
  runnerRequest: (...a: unknown[]) => runnerRequest(...a),
}));

import { RunnerRequestError } from './runner-transport.js';
import { runnerToolsPersona } from './runner-persona.js';
import { spawn } from 'child_process';

import {
  DENIED_BUILTINS,
  LAPTOP_CONNECT_TIMEOUT_MS,
  LAPTOP_PROXY,
  SESSION_KEY_FILE,
  TOOLS_PERSONA_WRITTEN,
  __resetListedToolsForTest,
  applyPlacementMode,
  ensureSessionKeys,
  releasePlacement,
  serveLaptopTools,
  startRelayForToolsPlacements,
  stopAgentsPlacedOn,
} from './runner-tools.js';

const TOKEN = 't'.repeat(43);
const placement = (mode: 'tools' | 'container', token: string | null = TOKEN) => ({
  agent_group_id: 'ag-1',
  fingerprint: 'fp-1',
  slots_json: '{}',
  created_by: 'u',
  created_at: 1,
  mode,
  tools_token: token,
});

let server: http.Server;
let url: string;
beforeEach(async () => {
  placements.clear();
  configs.clear();
  sessions.clear();
  killContainer.mockClear();
  runnerRequest.mockReset();
  __resetListedToolsForTest();
  startMcpRelay.mockClear();
  server = http.createServer((req, res) => void serveLaptopTools(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/laptop`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));
afterAll(() => fs.rmSync(dirs.base, { recursive: true, force: true }));

interface Reply {
  result: { tools?: unknown[]; content?: Array<{ type: string; text: string }>; isError?: boolean } & Record<
    string,
    unknown
  >;
}
const reply = async (r: Response): Promise<Reply> => (await r.json()) as Reply;
const rpc = (body: unknown, token = TOKEN, session = '') =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nanoclaw-relay': token, 'x-nanoclaw-session': session },
    body: JSON.stringify(body),
  });
/** A session's key, as central wrote it in its directory. */
const keyOf = (sid: string) =>
  fs.readFileSync(path.join(dirs.data, 'v2-sessions', 'ag-1', sid, SESSION_KEY_FILE), 'utf8').trim();

describe('the laptop tools endpoint', () => {
  it('refuses a token that is not a tools placement', async () => {
    placements.set('ag-1', placement('container'));
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(403);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'nope')).status).toBe(403);
  });

  it('initializes, lists the machine’s tools and forwards a call to the placed machine', async () => {
    placements.set('ag-1', placement('tools'));
    const init = await reply(
      await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    );
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'laptop' },
    });

    runnerRequest.mockResolvedValueOnce({ tools: [{ name: 'Read' }] });
    const list = await reply(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(list.result.tools).toEqual([{ name: 'Read' }, expect.objectContaining({ name: 'ReadAttachment' })]);
    expect(runnerRequest).toHaveBeenLastCalledWith(
      'fp-1',
      'tools.list',
      { installSlug: 'inst', agentGroupId: 'ag-1' },
      150_000,
    );

    runnerRequest.mockResolvedValueOnce({ text: '     1\tx', isError: false });
    const call = await reply(
      await rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'Read', arguments: { file_path: 'a' } },
      }),
    );
    expect(call.result).toEqual({ content: [{ type: 'text', text: '     1\tx' }] });
    expect(runnerRequest).toHaveBeenLastCalledWith(
      'fp-1',
      'tools.call',
      { installSlug: 'inst', agentGroupId: 'ag-1', name: 'Read', input: { file_path: 'a' } },
      120_000,
    );
  });

  it('tells the agent plainly when the machine is not connected, and passes tool errors through', async () => {
    placements.set('ag-1', placement('tools'));
    runnerRequest.mockRejectedValueOnce(new RunnerRequestError('not-connected', 'no link'));
    const off = await reply(
      await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Read', arguments: {} } }),
    );
    expect(off.result.isError).toBe(true);
    expect(off.result.content![0].text).toMatch(/not connected to NanoClaw right now/);
    runnerRequest.mockResolvedValueOnce({ text: 'read a.ts before changing it', isError: true });
    const bad = await reply(
      await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Edit', arguments: {} } }),
    );
    expect(bad.result).toEqual({ content: [{ type: 'text', text: 'read a.ts before changing it' }], isError: true });
  });

  it('answers a notification with 202 and a batch with a batch', async () => {
    placements.set('ag-1', placement('tools'));
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const batch = (await (
      await rpc([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'nope' },
      ])
    ).json()) as unknown;
    expect(batch).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'method not found: nope' } },
    ]);
  });
});

describe('attachments, read on central', () => {
  const inbox = (sid: string) => path.join(dirs.data, 'v2-sessions', 'ag-1', sid, 'inbox');
  type Result = { content: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean };
  const callAs = async (session: string, args: Record<string, unknown>): Promise<Result> =>
    (
      await reply(
        await rpc(
          { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'ReadAttachment', arguments: args } },
          TOKEN,
          session,
        ),
      )
    ).result as Result;
  /** As session s-1, the one these tests attach to. */
  const call = async (args: Record<string, unknown>): Promise<Result> => {
    await ensureSessionKeys('ag-1');
    return callAs(keyOf('s-1'), args);
  };

  it('reads a text attachment from the session’s inbox, numbered, without asking the machine', async () => {
    placements.set('ag-1', placement('tools'));
    sessions.set('ag-1', [{ id: 's-old' }, { id: 's-1' }]);
    fs.mkdirSync(path.join(inbox('s-1'), 'm1'), { recursive: true });
    fs.writeFileSync(path.join(inbox('s-1'), 'm1', 'report.txt'), 'one\ntwo\nthree');
    runnerRequest.mockClear();
    const r = await call({ file_path: '/workspace/inbox/m1/report.txt', offset: 2, limit: 1 });
    expect(r.content[0].text).toBe('     2\ttwo\n… 1 more lines: pass offset 3.');
    expect(r.isError).toBeUndefined();
    expect(runnerRequest).not.toHaveBeenCalled();
  });

  it("reads only the calling session's inbox, never another session's of the same group", async () => {
    placements.set('ag-1', placement('tools'));
    sessions.set('ag-1', [{ id: 's-1' }, { id: 's-2' }]);
    fs.mkdirSync(path.join(inbox('s-2'), 'm9'), { recursive: true });
    fs.writeFileSync(path.join(inbox('s-2'), 'm9', 'theirs.txt'), 'another room');
    await ensureSessionKeys('ag-1');
    expect(keyOf('s-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf('s-1')).not.toBe(keyOf('s-2'));
    // s-1 asks for a file only s-2 holds: not found, not read.
    const fromOther = await callAs(keyOf('s-1'), { file_path: '/workspace/inbox/m9/theirs.txt' });
    expect(fromOther.isError).toBe(true);
    expect(JSON.stringify(fromOther)).not.toContain('another room');
    expect((await callAs(keyOf('s-2'), { file_path: '/workspace/inbox/m9/theirs.txt' })).content[0].text).toBe(
      '     1\tanother room',
    );
    // No key, or one that is no session's: nothing at all.
    for (const key of ['', 'f'.repeat(64), keyOf('s-2').toUpperCase()]) {
      const r = await callAs(key, { file_path: '/workspace/inbox/m9/theirs.txt' });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain('another room');
    }
    // A key is written once: placing again does not replace it.
    const before = keyOf('s-1');
    await ensureSessionKeys('ag-1');
    expect(keyOf('s-1')).toBe(before);
  });

  it('gives images as images, and refuses binaries, other paths and escapes', async () => {
    placements.set('ag-1', placement('tools'));
    sessions.set('ag-1', [{ id: 's-1' }]);
    fs.mkdirSync(path.join(inbox('s-1'), 'm2'), { recursive: true });
    fs.writeFileSync(path.join(inbox('s-1'), 'm2', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
    fs.writeFileSync(path.join(inbox('s-1'), 'm2', 'blob.bin'), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(dirs.data, 'v2-sessions', 'ag-1', 's-1', 'inbound.db'), 'secret');
    expect((await call({ file_path: '/workspace/inbox/m2/shot.png' })).content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
    expect((await call({ file_path: '/workspace/inbox/m2/blob.bin' })).isError).toBe(true);
    expect((await call({ file_path: '/workspace/inbox/../inbound.db' })).isError).toBe(true);
    expect((await call({ file_path: '/etc/passwd' })).isError).toBe(true);
    expect((await call({ file_path: '/workspace/inbox/m2/missing.txt' })).isError).toBe(true);
  });

  it('reads the file it checked, even when the path is swapped for a symlink right after the check', async () => {
    placements.set('ag-1', placement('tools'));
    sessions.set('ag-1', [{ id: 's-1' }]);
    const note = path.join(inbox('s-1'), 'm3', 'note.txt');
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, 'attached');
    const secret = path.join(dirs.base, 'secret.txt');
    fs.writeFileSync(secret, 'outside the inbox');
    const realpath = fs.realpathSync;
    let swapped = false;
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      const out = realpath(p);
      if (!swapped && String(p) !== inbox('s-1')) {
        swapped = true;
        fs.unlinkSync(note);
        fs.symlinkSync(secret, note);
      }
      return out;
    }) as typeof fs.realpathSync);
    try {
      const r = await call({ file_path: '/workspace/inbox/m3/note.txt' });
      expect(swapped).toBe(true);
      expect(r.content[0].text).toBe('     1\tattached');
    } finally {
      spy.mockRestore();
    }
    expect((await call({ file_path: '/workspace/inbox/m3/note.txt' })).isError).toBe(true);
  });

  it("answers a machine's list at once once it has listed, while the machine takes its copy", async () => {
    placements.set('ag-1', placement('tools'));
    runnerRequest.mockResolvedValueOnce({ tools: [{ name: 'Read' }] });
    await reply(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    runnerRequest.mockReturnValueOnce(new Promise(() => {})); // the copy, still going
    const list = await reply(await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
    expect((list.result.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['Read', 'ReadAttachment']);
  });

  it('is listed even while the machine is away', async () => {
    placements.set('ag-1', placement('tools'));
    runnerRequest.mockRejectedValueOnce(new Error('gone'));
    const list = await reply(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect((list.result.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['ReadAttachment']);
  });
});

describe('placing a group on a machine, and releasing it', () => {
  const settings = () => path.join(dirs.data, 'v2-sessions', 'ag-1', '.claude-shared', 'settings.json');
  const persona = () => path.join(dirs.groups, 'folder-ag-1', 'instructions.prepend.md');
  const backup = () => path.join(dirs.groups, 'folder-ag-1', 'instructions.prepend.container.md');
  const own = 'The group’s own instructions (an older shipped text, or an admin’s).\n';
  const tools = `${runnerToolsPersona('devbox', 'jane@example.com').trimEnd()}\n`;

  beforeEach(() => {
    configs.set('ag-1', JSON.stringify({ docs: { type: 'http', url: 'https://docs.example.test/mcp' } }));
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.writeFileSync(settings(), JSON.stringify({ autoMemoryEnabled: false, permissions: { deny: ['WebFetch'] } }));
    fs.mkdirSync(path.dirname(persona()), { recursive: true });
    fs.writeFileSync(persona(), own);
    fs.rmSync(backup(), { force: true });
    fs.rmSync(path.join(dirs.groups, 'folder-ag-1', TOOLS_PERSONA_WRITTEN), { force: true });
  });

  it('placing adds the laptop server, denies the built-ins and swaps the instructions; releasing undoes all three exactly', async () => {
    await applyPlacementMode('ag-1', placement('tools') as never);
    expect(startMcpRelay).toHaveBeenCalled();
    expect(JSON.parse(configs.get('ag-1')!)).toEqual({
      docs: { type: 'http', url: 'https://docs.example.test/mcp' },
      laptop: {
        command: 'bun',
        args: ['-e', LAPTOP_PROXY],
        env: {
          NANOCLAW_LAPTOP_URL: 'http://host.docker.internal:3302/laptop',
          NANOCLAW_LAPTOP_TOKEN: TOKEN,
          NANOCLAW_LAPTOP_SESSION_FILE: '/workspace/.laptop-session',
          NO_PROXY: 'host.docker.internal,localhost,127.0.0.1',
          no_proxy: 'host.docker.internal,localhost,127.0.0.1',
        },
      },
    });
    const s = JSON.parse(fs.readFileSync(settings(), 'utf8'));
    expect(s.autoMemoryEnabled).toBe(false);
    expect(s.permissions.deny).toEqual(['WebFetch', ...DENIED_BUILTINS]);
    expect(s.env).toEqual({ MCP_TIMEOUT: LAPTOP_CONNECT_TIMEOUT_MS });
    expect(fs.readFileSync(persona(), 'utf8')).toBe(tools);
    expect(fs.readFileSync(backup(), 'utf8')).toBe(own);

    await releasePlacement('ag-1', placement('tools') as never);
    expect(JSON.parse(configs.get('ag-1')!)).toEqual({ docs: { type: 'http', url: 'https://docs.example.test/mcp' } });
    const released = JSON.parse(fs.readFileSync(settings(), 'utf8'));
    expect(released.permissions.deny).toEqual(['WebFetch']);
    expect(released.env).toBeUndefined();
    expect(fs.readFileSync(persona(), 'utf8')).toBe(own);
    expect(fs.existsSync(backup())).toBe(false);
  });

  it('keeps tools instructions an admin edited, leaving the earlier ones beside them', async () => {
    await applyPlacementMode('ag-1', placement('tools') as never);
    fs.writeFileSync(persona(), 'Edited while placed.\n');
    await releasePlacement('ag-1', placement('tools') as never);
    expect(fs.readFileSync(persona(), 'utf8')).toBe('Edited while placed.\n');
    expect(fs.readFileSync(backup(), 'utf8')).toBe(own);
  });

  it('brings tools instructions an older version wrote up to date at startup, and still restores on removal', async () => {
    const written = path.join(dirs.groups, 'folder-ag-1', TOOLS_PERSONA_WRITTEN);
    const older = 'You are the coding agent for devbox, as an older version put it.\n';
    await applyPlacementMode('ag-1', placement('tools') as never);
    placements.set('ag-1', placement('tools'));
    // Written by an older version that kept the hash…
    fs.writeFileSync(persona(), older);
    fs.writeFileSync(written, `${crypto.createHash('sha256').update(older).digest('hex')}\n`);
    await startRelayForToolsPlacements();
    expect(fs.readFileSync(persona(), 'utf8')).toBe(tools);
    // …and by one from before the hash: known by its opening line.
    fs.writeFileSync(persona(), `${tools.split('\n')[0]}\nolder body\n`);
    fs.rmSync(written);
    await startRelayForToolsPlacements();
    expect(fs.readFileSync(persona(), 'utf8')).toBe(tools);
    await releasePlacement('ag-1', placement('tools') as never);
    expect(fs.readFileSync(persona(), 'utf8')).toBe(own);
    expect(fs.existsSync(written)).toBe(false);
  });

  it('gives a group placed before the connect timeout existed that timeout at startup, keeping its own env', async () => {
    placements.set('ag-1', placement('tools'));
    fs.writeFileSync(settings(), JSON.stringify({ env: { ANTHROPIC_MODEL: 'm' } }));
    await startRelayForToolsPlacements();
    expect(JSON.parse(fs.readFileSync(settings(), 'utf8')).env).toEqual({
      ANTHROPIC_MODEL: 'm',
      MCP_TIMEOUT: LAPTOP_CONNECT_TIMEOUT_MS,
    });
  });

  it('a placement from before the laptop container was retired becomes a tools placement at startup, fully configured', async () => {
    placements.set('ag-1', placement('container', null));
    await startRelayForToolsPlacements();
    expect(placements.get('ag-1')).toMatchObject({ mode: 'tools', tools_token: 'n'.repeat(43) });
    expect(JSON.parse(configs.get('ag-1')!).laptop.env.NANOCLAW_LAPTOP_TOKEN).toBe('n'.repeat(43));
    expect(JSON.parse(fs.readFileSync(settings(), 'utf8')).permissions.deny).toEqual(['WebFetch', ...DENIED_BUILTINS]);
    expect(fs.readFileSync(persona(), 'utf8')).toBe(tools);
    expect(fs.readFileSync(backup(), 'utf8')).toBe(own);
  });
});

describe('stopping the agents placed on a machine', () => {
  it('stops every session of every group placed there, and nothing else', async () => {
    placements.set('ag-1', placement('tools'));
    placements.set('ag-2', { ...placement('tools'), agent_group_id: 'ag-2', fingerprint: 'fp-other' });
    sessions.set('ag-1', [{ id: 's1' }, { id: 's2' }]);
    sessions.set('ag-2', [{ id: 's3' }]);
    expect(await stopAgentsPlacedOn('fp-1', 'developer stopped all agents')).toBe(2);
    expect(killContainer.mock.calls).toEqual([
      ['s1', 'developer stopped all agents'],
      ['s2', 'developer stopped all agents'],
    ]);
  });
});

describe('the in-container proxy the agent runs as its laptop server', () => {
  it('waits for the relay to come up instead of failing, and forwards with the token', async () => {
    // The relay is not attached when the agent starts: every connection is
    // dropped until it is. The port stays bound throughout, so nothing else can take it.
    let attached = false;
    let dropped = 0;
    const seen: Array<{ token: unknown; session: unknown; body: string }> = [];
    const keyFile = path.join(dirs.base, 'proxy-session-key');
    fs.writeFileSync(keyFile, `${'a'.repeat(64)}\n`);
    const relay = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ token: req.headers['x-nanoclaw-relay'], session: req.headers['x-nanoclaw-session'], body });
        const id = (JSON.parse(body) as { id?: number }).id;
        if (id === undefined) return void res.writeHead(202).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }));
      });
    });
    relay.on('connection', (socket) => {
      if (attached) return;
      dropped++;
      socket.destroy();
    });
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
    const port = (relay.address() as AddressInfo).port;
    const proxy = spawn(process.execPath, ['-e', LAPTOP_PROXY], {
      env: {
        ...process.env,
        NANOCLAW_LAPTOP_URL: `http://127.0.0.1:${port}/laptop`,
        NANOCLAW_LAPTOP_TOKEN: TOKEN,
        NANOCLAW_LAPTOP_SESSION_FILE: keyFile,
      },
    });
    const out: string[] = [];
    proxy.stdout.on('data', (d: Buffer) => out.push(...d.toString().split('\n').filter(Boolean)));
    const until = (cond: () => boolean) =>
      vi.waitFor(
        () => {
          if (!cond()) throw new Error('not yet');
        },
        { timeout: 15_000, interval: 10 },
      );
    try {
      proxy.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      proxy.stdin.write('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
      // Both messages refused, then retried and refused again: still waiting, not failed.
      await until(() => dropped >= 4);
      expect(out).toEqual([]);
      attached = true;
      await until(() => out.length > 0);
      expect(out).toEqual(['{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}']);
      expect(seen.every((s) => s.token === TOKEN && s.session === 'a'.repeat(64))).toBe(true);
    } finally {
      proxy.kill();
      relay.closeAllConnections();
      await new Promise<void>((r) => relay.close(() => r()));
    }
  }, 20_000);
});
