/**
 * Agent-template endpoints: GET /api/templates, POST /api/agents/from-template.
 *
 * Two things are worth asserting and neither is about the happy path.
 *
 * AUTHORIZATION. Stamping creates scheduled tasks and MCP servers — surfaces a
 * scoped admin cannot otherwise touch — so both endpoints are owner / global
 * admin, matching agent import rather than agent create.
 *
 * CONTAINMENT. The ref is a path into a local directory, so the interesting
 * inputs are the escapes: absolute paths, a leading `~`, and `../`. Those are
 * rejected by resolveLocalTemplate upstream; these tests prove the HTTP surface
 * does not route around it. A 400 means the request reached the handler and the
 * resolver refused it — which is the assertion, since a 403 would mean the gate
 * fired first and told us nothing about containment.
 *
 * The library itself is a temp dir pointed at by NANOCLAW_TEMPLATES_DIR, so
 * these never touch the install's real templates/.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WebchatServer } from './server.js';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

let libDir = '';

beforeEach(async () => {
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const conn = await import('../../db/connection.js');
    await conn.closeDb();
  } catch {
    // ignore
  }
  if (libDir) fs.rmSync(libDir, { recursive: true, force: true });
  libDir = '';
  vi.resetModules();
});

/** A minimal conformant plugin: only plugin.json is required by the spec. */
function makeLibrary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tpl-test-'));
  const tpl = path.join(dir, 'demo', 'helper');
  fs.mkdirSync(tpl, { recursive: true });
  fs.writeFileSync(
    path.join(tpl, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'helper',
      version: '1.0.0',
      description: 'A test plugin',
    }),
  );
  return dir;
}

async function loadServerWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  await migrations.runMigrations(conn.getDb());
  return { server: await import('./server.js'), conn };
}

async function httpRequest(
  port: number,
  method: string,
  reqPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const portOf = (wc: { http: { address: () => unknown } }): number => {
  const a = wc.http.address();
  return typeof a === 'object' && a ? (a as { port: number }).port : 0;
};

const now = '2026-08-17T00:00:00.000Z';
function seed(db: import('../../db/driver.js').DbDriver): void {
  const user = async (id: string) =>
    await db.run(
      `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`,
      id,
      now,
    );
  const group = async (id: string) =>
    await db.run(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
      id,
      id,
      id,
      now,
    );
  const role = async (uid: string, r: 'owner' | 'admin', g: string | null) => {
    await user(uid);
    if (g) await group(g);
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)`,
      uid,
      r,
      g,
      now,
    );
  };
  group('ag-test-a');
  role('webchat:owner', 'owner', null);
  role('webchat:admina', 'admin', 'ag-test-a'); // scoped admin only
  user('webchat:nobody');
}

describe('agent-template endpoints', () => {
  let server: Awaited<ReturnType<typeof loadServerWithEnv>>['server'];
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    libDir = makeLibrary();
    const loaded = await loadServerWithEnv({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
      NANOCLAW_TEMPLATES_DIR: libDir,
    });
    server = loaded.server;
    seed(loaded.conn.getDb());
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (name: string) => ({ 'x-forwarded-user': name });
  const post = (b: unknown, who: string) =>
    httpRequest(
      port,
      'POST',
      '/api/agents/from-template',
      { ...as(who), 'content-type': 'application/json', 'x-webchat-csrf': '1' },
      JSON.stringify(b),
    );

  describe('GET /api/templates', () => {
    it('lists the local library for the owner, with manifest metadata', async () => {
      const r = await httpRequest(port, 'GET', '/api/templates', as('owner'));
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body) as { templates: Array<{ ref: string; name: string; description?: string }> };
      expect(body.templates).toHaveLength(1);
      expect(body.templates[0]).toMatchObject({ ref: 'demo/helper', name: 'helper', description: 'A test plugin' });
    });

    // The pre-stamp plan is only worth having if it shows the thing that
    // actually needs judging. `command` is constrained by the reader, but
    // `args` is not — `command: "bash"` with `args: ["-c", …]` is a legal
    // template — so the argv has to reach the operator verbatim. env VALUES
    // must not: keys name what a server wants, values stay on the host.
    it('reports each MCP server as the argv it will run, with env KEYS only', async () => {
      const tpl = path.join(libDir, 'demo', 'helper');
      fs.writeFileSync(
        path.join(tpl, 'mcp.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
          mcpServers: {
            files: {
              type: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
              env: { DATA_DIR: '/tmp/should-not-be-reported' },
            },
          },
        }),
      );

      const r = await httpRequest(port, 'GET', '/api/templates/detail?ref=demo%2Fhelper', as('owner'));
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body) as {
        mcpServers: Array<{ name: string; transport: string; command?: string; args?: string[]; envKeys?: string[] }>;
      };

      expect(body.mcpServers).toHaveLength(1);
      expect(body.mcpServers[0]).toMatchObject({
        name: 'files',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        envKeys: ['DATA_DIR'],
      });
      // The whole response, not just that field: a value leaking anywhere in
      // the payload is the failure this guards against.
      expect(r.body).not.toContain('should-not-be-reported');
    });

    it('refuses a scoped admin and a non-admin', async () => {
      expect((await httpRequest(port, 'GET', '/api/templates', as('admina'))).status).toBe(403);
      expect((await httpRequest(port, 'GET', '/api/templates', as('nobody'))).status).toBe(403);
    });
  });

  describe('POST /api/agents/from-template', () => {
    it('refuses a scoped admin and a non-admin', async () => {
      expect((await post({ ref: 'demo/helper' }, 'admina')).status).toBe(403);
      expect((await post({ ref: 'demo/helper' }, 'nobody')).status).toBe(403);
    });

    it('requires a ref', async () => {
      expect((await post({}, 'owner')).status).toBe(400);
      expect((await post({ ref: '   ' }, 'owner')).status).toBe(400);
    });

    // Containment: the handler must not route around resolveLocalTemplate.
    // 400 (not 403) proves the gate passed and the RESOLVER did the refusing.
    it.each([
      ['absolute path', '/etc'],
      ['home escape', '~/secrets'],
      ['parent escape', '../../etc'],
      ['nested parent escape', 'demo/../../etc'],
    ])('rejects %s', async (_label, ref) => {
      const r = await post({ ref }, 'owner');
      expect(r.status).toBe(400);
    });

    it('rejects a ref that is not a template', async () => {
      const r = await post({ ref: 'demo' }, 'owner'); // a directory, but no plugin.json
      expect(r.status).toBe(400);
    });
  });

  // ── Library management ────────────────────────────────────────────────────
  // Same gate as stamping (these decide what CAN be stamped), and the same
  // containment rule: a ref is a path into the library and must not leave it.

  describe('template sources', () => {
    it('ships the public registry seeded and official', async () => {
      const r = await httpRequest(port, 'GET', '/api/template-sources', as('owner'));
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body) as { sources: Array<{ id: string; owner: string; official: boolean }> };
      expect(body.sources).toEqual([
        expect.objectContaining({ id: 'nanoclaw-templates', owner: 'nanocoai', official: true }),
      ]);
    });

    it('refuses a scoped admin and a non-admin', async () => {
      expect((await httpRequest(port, 'GET', '/api/template-sources', as('admina'))).status).toBe(403);
      expect((await httpRequest(port, 'GET', '/api/template-sources', as('nobody'))).status).toBe(403);
    });

    it('adds a source, and rejects owner/repo that are not plain GitHub names', async () => {
      const add = (b: unknown) =>
        httpRequest(
          port,
          'POST',
          '/api/template-sources',
          { ...as('owner'), 'content-type': 'application/json', 'x-webchat-csrf': '1' },
          JSON.stringify(b),
        );
      expect((await add({ owner: 'me', repo: 'my-templates' })).status).toBe(200);
      // Anything that could steer the API path we build must not get through.
      expect((await add({ owner: '../../etc', repo: 'x' })).status).toBe(400);
      expect((await add({ owner: 'me', repo: 'a/b' })).status).toBe(400);
      expect((await add({ owner: 'me' })).status).toBe(400);
    });

    it('will not delete a built-in source — it would return on the next migrate', async () => {
      const del = (id: string) =>
        httpRequest(port, 'DELETE', `/api/template-sources/${id}`, { ...as('owner'), 'x-webchat-csrf': '1' });
      expect((await del('nanoclaw-templates')).status).toBe(400);
      expect((await del('does-not-exist')).status).toBe(400);
    });
  });

  describe('template detail and delete', () => {
    it('describes what a template contains', async () => {
      const r = await httpRequest(port, 'GET', '/api/templates/detail?ref=demo%2Fhelper', as('owner'));
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body) as { ref: string; skills: string[]; persona: string | null };
      expect(body.ref).toBe('demo/helper');
      // A conformant plugin with nothing but a manifest is valid, and its
      // emptiness must read as empty rather than as an error.
      expect(body.skills).toEqual([]);
      expect(body.persona).toBeNull();
    });

    it.each([
      ['absolute path', '/etc'],
      ['home escape', '~/secrets'],
      ['parent escape', '../../etc'],
    ])('detail rejects %s', async (_l, ref) => {
      const r = await httpRequest(port, 'GET', `/api/templates/detail?ref=${encodeURIComponent(ref)}`, as('owner'));
      expect(r.status).toBe(400);
    });

    it('delete refuses an escaping ref, and removes a real one', async () => {
      const del = (ref: string) =>
        httpRequest(port, 'DELETE', `/api/templates?ref=${encodeURIComponent(ref)}`, {
          ...as('owner'),
          'x-webchat-csrf': '1',
        });
      expect((await del('../../etc')).status).toBe(400);
      expect((await del('demo/helper')).status).toBe(200);
      expect((await httpRequest(port, 'GET', '/api/templates', as('owner'))).body).toContain('"templates":[]');
    });

    it('delete refuses a scoped admin', async () => {
      const r = await httpRequest(port, 'DELETE', '/api/templates?ref=demo%2Fhelper', {
        ...as('admina'),
        'x-webchat-csrf': '1',
      });
      expect(r.status).toBe(403);
    });
  });

  describe('fetching from a source', () => {
    it('requires source and ref, and 404s an unknown source', async () => {
      const fetchT = (b: unknown) =>
        httpRequest(
          port,
          'POST',
          '/api/templates/fetch',
          { ...as('owner'), 'content-type': 'application/json', 'x-webchat-csrf': '1' },
          JSON.stringify(b),
        );
      expect((await fetchT({})).status).toBe(400);
      expect((await fetchT({ source: 'nanoclaw-templates' })).status).toBe(400);
      expect((await fetchT({ source: 'no-such-source', ref: 'a/b' })).status).toBe(404);
    });

    it('refuses a scoped admin before it reaches the network', async () => {
      const r = await httpRequest(
        port,
        'POST',
        '/api/templates/fetch',
        { ...as('admina'), 'content-type': 'application/json', 'x-webchat-csrf': '1' },
        JSON.stringify({ source: 'nanoclaw-templates', ref: 'sales/sdr' }),
      );
      expect(r.status).toBe(403);
    });
  });

  describe('updating a stamped agent', () => {
    const plan = (id: string, who = 'owner') => httpRequest(port, 'GET', `/api/agents/${id}/template`, as(who));

    it('reports an agent that was never stamped as simply not stamped', async () => {
      const r = await plan('ag-test-a');
      expect(r.status).toBe(200);
      // Not an error and not an empty plan: "no template" is a real answer,
      // and conflating it with a failure would send the reader hunting.
      expect(JSON.parse(r.body)).toEqual({ stamped: false });
    });

    it('404s an unknown agent and refuses a scoped admin', async () => {
      expect((await plan('ag-nope')).status).toBe(404);
      expect((await plan('ag-test-a', 'admina')).status).toBe(403);
      expect((await plan('ag-test-a', 'nobody')).status).toBe(403);
    });

    it('refuses to apply an update to an agent that carries no template', async () => {
      const r = await httpRequest(port, 'POST', '/api/agents/ag-test-a/template/apply', {
        ...as('owner'),
        'x-webchat-csrf': '1',
      });
      expect(r.status).toBe(400);
    });

    it('refuses apply for a scoped admin before touching anything', async () => {
      const r = await httpRequest(port, 'POST', '/api/agents/ag-test-a/template/apply', {
        ...as('admina'),
        'x-webchat-csrf': '1',
      });
      expect(r.status).toBe(403);
    });
  });
});
