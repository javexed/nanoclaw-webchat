import http from 'http';
import net, { type AddressInfo } from 'net';

import { afterEach, describe, expect, it, vi } from 'vitest';

/** Rows the fake DB answers with, by table; empty = nothing found. */
const db = vi.hoisted(() => ({ rows: {} as Record<string, unknown> }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    get: async (sql: string) => {
      if (sql.includes('FROM webchat_agent_mcp_servers WHERE relay_token')) return db.rows.assignment;
      if (sql.includes('FROM webchat_mcp_servers WHERE id')) return db.rows.server;
      return undefined;
    },
  }),
}));

const audits = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../audit.js', () => ({ audit: (e: Record<string, unknown>) => void audits.push(e) }));
vi.mock('../../modules/approvals/primitive.js', () => ({
  requestApproval: async () => undefined,
  registerApprovalHandler: () => undefined,
  registerApprovalResolvedHandler: () => undefined,
}));
vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: async () => [{ id: 's1', last_active: 'x', status: 'active' }],
}));
vi.mock('../../container-runner.js', () => ({ isContainerRunning: () => true }));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: async () => ({ name: 'Agent' }) }));

afterEach(async () => {
  const relay = await import('./mcp-relay.js');
  relay.stopMcpRelay();
  delete process.env.WEBCHAT_EXEC_RELAY;
  delete process.env.WEBCHAT_MCP_RELAY_PORT;
  db.rows = {};
  vi.resetModules();
});

/**
 * A port the OS says is free right now. The relay takes a fixed port from its
 * env (it has to: agents are told the number), so the test cannot hand it 0;
 * a random pick from a range collided with whatever else the run was listening
 * on, the relay never bound, and the probe timed out.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe('the MCP relay under the exec relay', () => {
  it('listens on loopback, where central reaches it for relayed agents, bridge or no bridge', async () => {
    process.env.WEBCHAT_EXEC_RELAY = '1';
    process.env.WEBCHAT_MCP_RELAY_PORT = String(await freePort());
    vi.resetModules();
    const relay = await import('./mcp-relay.js');
    relay.registerRelayRoute('/probe', async (_req, res) => void res.writeHead(200).end('relay here'));
    relay.startMcpRelay();
    const target = relay.mcpRelayTarget();
    expect(target.host).toBe('127.0.0.1');
    let text = '';
    for (let i = 0; i < 50 && !text; i++) {
      text = await fetch(`http://127.0.0.1:${target.port}/probe`)
        .then((r) => r.text())
        .catch(() => '');
      if (!text) await new Promise((r) => setTimeout(r, 20));
    }
    expect(text).toBe('relay here');
  });

  it('without it, central reaches the relay where containers do', async () => {
    vi.resetModules();
    const relay = await import('./mcp-relay.js');
    process.env.WEBCHAT_MCP_RELAY_HOST = '198.51.100.7';
    expect(relay.mcpRelayTarget().host).toBe('198.51.100.7');
    delete process.env.WEBCHAT_MCP_RELAY_HOST;
  });
});

describe('relayTargetUrl — confines a relayed path to the configured server', () => {
  const BASE = 'https://mcp.example.com/api/mcp';
  const target = async (sub: string, query = '') => (await import('./mcp-relay.js')).relayTargetUrl(BASE, sub, query);

  it('keeps a normal sub-path and query under the base', async () => {
    expect(await target('', '')).toBe('https://mcp.example.com/api/mcp');
    expect(await target('/sse', '?session=1')).toBe('https://mcp.example.com/api/mcp/sse?session=1');
    expect(await target('/a%20b')).toBe('https://mcp.example.com/api/mcp/a%20b');
  });

  it.each([
    ['/..', 'dot-dot'],
    ['/../../admin', 'dot-dot climbing out'],
    ['/x/../../admin', 'dot-dot after a segment'],
    ['/%2e%2e/admin', 'encoded dot-dot'],
    ['/%2E%2e/admin', 'mixed-case encoded dot-dot'],
    ['/.%2e/admin', 'half-encoded dot-dot'],
    ['/%252e%252e/admin', 'double-encoded dot-dot'],
    ['/x%2f..%2fadmin', 'encoded slash around dot-dot'],
    ['/\\..\\admin', 'backslashes'],
    ['/x%5c..%5cadmin', 'encoded backslashes'],
    ['/%25252525252e', 'encoding nested past the decode limit'],
  ])('refuses %s (%s)', async (sub) => {
    expect(await target(sub)).toBeNull();
  });

  it('keeps an absolute URL in the path on the configured origin', async () => {
    const t = await target('//evil.example/x');
    expect(t === null || new URL(t).origin === 'https://mcp.example.com').toBe(true);
    const t2 = await target('/http://evil.example/x');
    expect(t2 && new URL(t2).origin).toBe('https://mcp.example.com');
  });

  it('a server at the origin root takes any path on that origin, never another', async () => {
    const { relayTargetUrl } = await import('./mcp-relay.js');
    expect(relayTargetUrl('https://mcp.example.com/', '/tools', '')).toBe('https://mcp.example.com/tools');
    expect(relayTargetUrl('https://mcp.example.com', '/..', '')).toBeNull();
  });
});

describe('the MCP relay forward', () => {
  async function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  async function startRelay(): Promise<string> {
    process.env.WEBCHAT_EXEC_RELAY = '1';
    process.env.WEBCHAT_MCP_RELAY_PORT = String(await freePort());
    vi.resetModules();
    const relay = await import('./mcp-relay.js');
    relay.startMcpRelay();
    const { port } = relay.mcpRelayTarget();
    for (let i = 0; i < 50; i++) {
      const up = await fetch(`http://127.0.0.1:${port}/nothing`)
        .then(() => true)
        .catch(() => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return `http://127.0.0.1:${port}`;
  }

  /** A GET with the path sent verbatim (fetch would normalise dot segments client-side). */
  function rawGet(base: string, path: string): Promise<number> {
    const u = new URL(base);
    return new Promise((resolve, reject) => {
      http
        .get({ host: u.hostname, port: u.port, path, headers: { 'x-nanoclaw-relay': 'tok' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
  }

  function assign(serverUrl: string): void {
    db.rows.assignment = { agent_group_id: 'ag1', mcp_server_id: 'srv1' };
    db.rows.server = {
      id: 'srv1',
      url: serverUrl,
      headers: null,
      auth: JSON.stringify({ kind: 'bearer', token: 'SECRET' }),
    };
  }

  it('forwards a normal sub-path with the credential, and refuses an escaping one without a request', async () => {
    const seen: Array<{ url?: string; auth?: string }> = [];
    const mcp = await listen((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    try {
      assign(`${mcp.base}/mcp`);
      const relay = await startRelay();
      const ok = await fetch(`${relay}/relay/srv1/sse?x=1`, { headers: { 'x-nanoclaw-relay': 'tok' } });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('ok');
      expect(seen).toEqual([{ url: '/mcp/sse?x=1', auth: 'Bearer SECRET' }]);

      for (const path of ['/relay/srv1/../admin', '/relay/srv1/%2e%2e/admin', '/relay/srv1/%252e%252e/admin']) {
        expect(await rawGet(relay, path)).toBe(400);
      }
      expect(seen).toHaveLength(1);
    } finally {
      mcp.server.close();
    }
  });

  it('holds a tool that needs approval without calling upstream, forwards the rest, and audits both', async () => {
    const bodies: string[] = [];
    const mcp = await listen((req, res) => {
      let t = '';
      req.on('data', (c) => (t += c));
      req.on('end', () => {
        bodies.push(t);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":2,"result":{}}');
      });
    });
    try {
      assign(`${mcp.base}/mcp`);
      db.rows.server = { ...(db.rows.server as object), approval_tools: JSON.stringify(['check_in_all']) };
      audits.length = 0;
      const relay = await startRelay();
      const post = (name: string, id: number) =>
        fetch(`${relay}/relay/srv1`, {
          method: 'POST',
          headers: { 'x-nanoclaw-relay': 'tok', 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { a: 1 } } }),
        });
      const held = await post('check_in_all', 1);
      expect(held.status).toBe(200);
      const j = (await held.json()) as { id: number; result: { isError: boolean; content: Array<{ text: string }> } };
      expect(j.id).toBe(1);
      expect(j.result.isError).toBe(true);
      expect(j.result.content[0]!.text).toMatch(/needs an owner's approval; a card was sent/);
      expect(bodies).toEqual([]);

      const ok = await post('explain_test_case', 2);
      expect(ok.status).toBe(200);
      await ok.text();
      expect(JSON.parse(bodies[0]!)).toMatchObject({ params: { name: 'explain_test_case' } });
      await new Promise((r) => setTimeout(r, 20));
      expect(audits.map((e) => e.detail as { tool: string; outcome: string })).toEqual([
        expect.objectContaining({ tool: 'check_in_all', outcome: 'held' }),
        expect.objectContaining({ tool: 'explain_test_case', outcome: 'http 200' }),
      ]);
    } finally {
      mcp.server.close();
    }
  });

  it('refuses a body it cannot read as JSON, whatever its content type, without calling upstream', async () => {
    let hits = 0;
    const mcp = await listen((_req, res) => {
      hits++;
      res.writeHead(200).end('{}');
    });
    try {
      assign(`${mcp.base}/mcp`);
      db.rows.server = { ...(db.rows.server as object), approval_tools: JSON.stringify(['check_in_all']) };
      const relay = await startRelay();
      const call = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_in_all","arguments":{}}}';
      const send = (body: string, type?: string, method = 'POST') =>
        fetch(`${relay}/relay/srv1`, {
          method,
          headers: { 'x-nanoclaw-relay': 'tok', ...(type ? { 'content-type': type } : {}) },
          body,
        });
      expect((await send(`\uFEFF${call}`, 'application/json')).status).toBe(400); // BOM
      expect((await send(call.replace('{}}}', '{"n":NaN}}}'), 'application/json')).status).toBe(400); // NaN
      expect((await send(`${call} trailing`, 'text/plain')).status).toBe(400);
      expect((await send('', undefined)).status).toBe(400);
      expect((await send(call, 'application/json', 'PUT')).status).toBe(405);
      expect(hits).toBe(0);
      // Valid JSON under the wrong content type is still read, so still held.
      const held = await send(call, 'text/plain');
      expect(((await held.json()) as { result: { isError: boolean } }).result.isError).toBe(true);
      expect(hits).toBe(0);
    } finally {
      mcp.server.close();
    }
  });

  it('audits a call whose response is cut off mid-stream', async () => {
    const mcp = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message\ndata: {}\n\n'); // never ends
      });
    });
    try {
      assign(`${mcp.base}/mcp`);
      audits.length = 0;
      const relay = await startRelay();
      const ac = new AbortController();
      const r = await fetch(`${relay}/relay/srv1`, {
        method: 'POST',
        headers: { 'x-nanoclaw-relay': 'tok', 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"slow","arguments":{}}}',
        signal: ac.signal,
      });
      expect(r.status).toBe(200);
      ac.abort();
      for (let i = 0; i < 150 && !audits.length; i++) await new Promise((res) => setTimeout(res, 20));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.detail).toMatchObject({ tool: 'slow', outcome: 'http 200, cut off' });
    } finally {
      mcp.server.closeAllConnections?.();
      mcp.server.close();
    }
  });

  it('does not follow a redirect with the credential', async () => {
    const elsewhere: string[] = [];
    const other = await listen((req, res) => {
      elsewhere.push(String(req.headers.authorization));
      res.writeHead(200).end('stolen');
    });
    const mcp = await listen((_req, res) => {
      res.writeHead(307, { location: `${other.base}/collect` }).end();
    });
    try {
      assign(`${mcp.base}/mcp`);
      const relay = await startRelay();
      const r = await fetch(`${relay}/relay/srv1`, { headers: { 'x-nanoclaw-relay': 'tok' } });
      expect(r.status).toBe(502);
      expect(elsewhere).toEqual([]);
    } finally {
      mcp.server.close();
      other.server.close();
    }
  });

  it('an upstream that dies mid-stream ends the response instead of throwing', async () => {
    const thrown: unknown[] = [];
    const onErr = (e: unknown) => thrown.push(e);
    process.on('uncaughtException', onErr);
    const mcp = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.socket?.destroy(), 30);
    });
    try {
      assign(`${mcp.base}/mcp`);
      const relay = await startRelay();
      const r = await fetch(`${relay}/relay/srv1`, { headers: { 'x-nanoclaw-relay': 'tok' } });
      expect(r.status).toBe(200);
      await r.text().catch(() => '');
      await new Promise((r) => setTimeout(r, 100));
      expect(thrown).toEqual([]);
      // Still serving.
      const again = await fetch(`${relay}/relay/srv1`, { headers: { 'x-nanoclaw-relay': 'tok' } });
      expect(again.status).toBe(200);
      await again.text().catch(() => '');
    } finally {
      process.off('uncaughtException', onErr);
      mcp.server.close();
    }
  });

  it('a client that leaves ends the upstream call', async () => {
    let upstreamClosed = false;
    const mcp = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      req.socket.on('close', () => (upstreamClosed = true));
    });
    try {
      assign(`${mcp.base}/mcp`);
      const relay = await startRelay();
      const ac = new AbortController();
      const r = await fetch(`${relay}/relay/srv1`, { headers: { 'x-nanoclaw-relay': 'tok' }, signal: ac.signal });
      await r.body!.getReader().read();
      ac.abort();
      for (let i = 0; i < 50 && !upstreamClosed; i++) await new Promise((r) => setTimeout(r, 20));
      expect(upstreamClosed).toBe(true);
    } finally {
      mcp.server.close();
    }
  });
});
