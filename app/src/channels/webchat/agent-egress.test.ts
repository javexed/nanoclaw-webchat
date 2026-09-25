/**
 * Authorization + validation for PUT /api/agents/:id/egress.
 *
 * Egress is a per-agent setting, so it follows hasAdminPrivilege like the rest
 * of the per-group surface. The interesting cases are the refusals:
 *
 *   - 'none' is NOT settable here. It leaves the agent unable to reach any model
 *     API at all (Anthropic, or a host-local LiteLLM/Ollama), so it cannot run.
 *     `ncl groups config update --egress none` stays for a genuinely air-gapped
 *     container; a one-click path to a dead agent does not.
 *   - 'open' stores NULL, so "never set" and "explicitly open" stay identical to
 *     every reader of the row.
 *
 * Same boot/teardown pattern as tool-secrets-scope-auth.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WebchatServer } from './server.js';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };

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
  vi.resetModules();
});

async function loadServerWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v ?? '');
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
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
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

const now = '2026-07-30T00:00:00.000Z';
async function seed(db: import('../../db/driver.js').DbDriver): Promise<void> {
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
  await group('ag-net-a');
  await group('ag-net-b');
  await role('webchat:owner', 'owner', null);
  await role('webchat:admina', 'admin', 'ag-net-a');
  await user('webchat:nobody');
}

describe('PUT /api/agents/:id/egress', () => {
  let server: Awaited<ReturnType<typeof loadServerWithEnv>>['server'];
  let wc: WebchatServer;
  let port: number;
  let conn: Awaited<ReturnType<typeof loadServerWithEnv>>['conn'];

  beforeEach(async () => {
    const loaded = await loadServerWithEnv({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
    });
    server = loaded.server;
    conn = loaded.conn;
    await seed(conn.getDb());
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (n: string) => ({ 'x-forwarded-user': n, 'content-type': 'application/json', 'x-webchat-csrf': '1' });
  const put = (agent: string, who: string, egress: unknown) =>
    httpRequest(port, 'PUT', `/api/agents/${agent}/egress`, as(who), JSON.stringify({ egress }));
  const stored = async (id: string) =>
    (
      (await conn.getDb().get(`SELECT egress FROM container_configs WHERE agent_group_id = ?`, id)) as
        | { egress: string | null }
        | undefined
    )?.egress ?? null;

  it('a scoped admin may lock down an agent they administer', async () => {
    const r = await put('ag-net-a', 'admina', 'host-only');
    expect(r.status).toBe(200);
    expect(await stored('ag-net-a')).toBe('host-only');
  });

  // Unset now means the allowlist, so open has to be written out to mean open.
  it("open is stored as 'open' — an unset mode is the allowlist", async () => {
    await put('ag-net-a', 'admina', 'host-only');
    const r = await put('ag-net-a', 'admina', 'open');
    expect(r.status).toBe(200);
    expect(await stored('ag-net-a')).toBe('open');
  });

  it('a scoped admin is refused on an agent they do NOT administer', async () => {
    const r = await put('ag-net-b', 'admina', 'host-only');
    expect(r.status).toBe(403);
    expect(await stored('ag-net-b')).toBeNull();
  });

  it('a user with no role anywhere is refused', async () => {
    const r = await put('ag-net-a', 'nobody', 'host-only');
    expect(r.status).toBe(403);
  });

  it('owner reaches any agent', async () => {
    const r = await put('ag-net-b', 'owner', 'host-only');
    expect(r.status).toBe(200);
  });

  // 'none' used to cut the network (and the model with it). It now means
  // "model only", enforced by the egress filter, so it is safe to offer.
  it("accepts 'none' — model only, the model stays reachable", async () => {
    const r = await put('ag-net-a', 'owner', 'none');
    expect(r.status).toBe(200);
    expect(await stored('ag-net-a')).toBe('none');
  });

  it('refuses anything else, including near-misses', async () => {
    for (const bad of ['', 'Open', 'hostonly', 'host_only', true, 1, null]) {
      const r = await put('ag-net-a', 'owner', bad);
      expect(r.status).toBe(400);
    }
    expect(await stored('ag-net-a')).toBeNull();
  });

  it('requires the CSRF header even for the right admin', async () => {
    const r = await httpRequest(
      port,
      'PUT',
      '/api/agents/ag-net-a/egress',
      { 'x-forwarded-user': 'admina', 'content-type': 'application/json' },
      JSON.stringify({ egress: 'host-only' }),
    );
    expect(r.status).toBe(403);
    expect(await stored('ag-net-a')).toBeNull();
  });

  it('404s an unknown agent', async () => {
    const r = await put('ag-does-not-exist', 'owner', 'host-only');
    expect(r.status).toBe(404);
  });
});

describe('/api/agents/:id/egress/hosts', () => {
  let server: Awaited<ReturnType<typeof loadServerWithEnv>>['server'];
  let wc: WebchatServer;
  let port: number;
  let conn: Awaited<ReturnType<typeof loadServerWithEnv>>['conn'];

  beforeEach(async () => {
    const loaded = await loadServerWithEnv({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
    });
    server = loaded.server;
    conn = loaded.conn;
    await seed(conn.getDb());
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (n: string) => ({ 'x-forwarded-user': n, 'content-type': 'application/json', 'x-webchat-csrf': '1' });
  const put = (agent: string, who: string, hosts: unknown) =>
    httpRequest(port, 'PUT', `/api/agents/${agent}/egress/hosts`, as(who), JSON.stringify({ hosts }));
  const get = (agent: string, who: string) => httpRequest(port, 'GET', `/api/agents/${agent}/egress/hosts`, as(who));

  it("a scoped admin sets their agent's hosts, normalized; the agent's policy then includes them", async () => {
    const r = await put('ag-net-a', 'admina', ['https://Pkgs.Example.org/x', '*.internal.example.org:8443']);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).hosts).toEqual(['pkgs.example.org', '*.internal.example.org:8443']);
    const g = JSON.parse((await get('ag-net-a', 'admina')).body);
    expect(g.hosts).toEqual(['pkgs.example.org', '*.internal.example.org:8443']);
    expect(g.install).toContain('registry.npmjs.org');
    expect(g.always).toContain('api.anthropic.com');
    const policy = await import('./egress-policy.js');
    expect(await policy.allowlistFor('ag-net-a')).toContain('pkgs.example.org');
    expect(await policy.allowlistFor('ag-net-b')).not.toContain('pkgs.example.org');
  });

  it('an empty list removes the row', async () => {
    await put('ag-net-a', 'owner', ['pkgs.example.org']);
    expect((await put('ag-net-a', 'owner', [])).status).toBe(200);
    const row = await conn.getDb().get(`SELECT 1 FROM webchat_agent_egress_hosts WHERE agent_group_id = ?`, 'ag-net-a');
    expect(row).toBeUndefined();
  });

  it('refuses another agent, no role, no CSRF header, and anything that is not a host list', async () => {
    expect((await put('ag-net-b', 'admina', ['a.example.org'])).status).toBe(403);
    expect((await get('ag-net-b', 'admina')).status).toBe(403);
    expect((await put('ag-net-a', 'nobody', ['a.example.org'])).status).toBe(403);
    const noCsrf = await httpRequest(
      port,
      'PUT',
      '/api/agents/ag-net-a/egress/hosts',
      { 'x-forwarded-user': 'admina', 'content-type': 'application/json' },
      JSON.stringify({ hosts: ['a.example.org'] }),
    );
    expect(noCsrf.status).toBe(403);
    for (const bad of ['a.example.org', ['localhost'], ['*'], [1]])
      expect((await put('ag-net-a', 'owner', bad)).status).toBe(400);
    expect((await put('ag-nope', 'owner', [])).status).toBe(404);
    const row = await conn.getDb().get(`SELECT 1 FROM webchat_agent_egress_hosts`);
    expect(row).toBeUndefined();
  });
});
