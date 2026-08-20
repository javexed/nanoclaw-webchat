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

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    const conn = await import('../../db/connection.js');
    conn.closeDb();
  } catch {
    // ignore
  }
  vi.resetModules();
});

async function loadServerWithEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v ?? '');
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  migrations.runMigrations(conn.getDb());
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
function seed(db: import('better-sqlite3').Database): void {
  const user = (id: string) =>
    db
      .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`)
      .run(id, now);
  const group = (id: string) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(id, id, id, now);
  const role = (uid: string, r: 'owner' | 'admin', g: string | null) => {
    user(uid);
    if (g) group(g);
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)`,
    ).run(uid, r, g, now);
  };
  group('ag-net-a');
  group('ag-net-b');
  role('webchat:owner', 'owner', null);
  role('webchat:admina', 'admin', 'ag-net-a');
  user('webchat:nobody');
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
    seed(conn.getDb());
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
    expect(stored('ag-net-a')).toBe('host-only');
  });

  it('open is stored as NULL, so it is indistinguishable from never-set', async () => {
    await put('ag-net-a', 'admina', 'host-only');
    const r = await put('ag-net-a', 'admina', 'open');
    expect(r.status).toBe(200);
    expect(stored('ag-net-a')).toBeNull();
  });

  it('a scoped admin is refused on an agent they do NOT administer', async () => {
    const r = await put('ag-net-b', 'admina', 'host-only');
    expect(r.status).toBe(403);
    expect(stored('ag-net-b')).toBeNull();
  });

  it('a user with no role anywhere is refused', async () => {
    const r = await put('ag-net-a', 'nobody', 'host-only');
    expect(r.status).toBe(403);
  });

  it('owner reaches any agent', async () => {
    const r = await put('ag-net-b', 'owner', 'host-only');
    expect(r.status).toBe(200);
  });

  // The whole point of not exposing it: 'none' leaves the agent unable to reach
  // any model API, so it cannot run at all.
  it("refuses 'none' — it is ncl-only, not a one-click dead agent", async () => {
    const r = await put('ag-net-a', 'owner', 'none');
    expect(r.status).toBe(400);
    expect(r.body).toContain("'open' or 'host-only'");
    expect(stored('ag-net-a')).toBeNull();
  });

  it('refuses anything else, including near-misses', async () => {
    for (const bad of ['', 'Open', 'hostonly', 'host_only', true, 1, null]) {
      const r = await put('ag-net-a', 'owner', bad);
      expect(r.status).toBe(400);
    }
    expect(stored('ag-net-a')).toBeNull();
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
    expect(stored('ag-net-a')).toBeNull();
  });

  it('404s an unknown agent', async () => {
    const r = await put('ag-does-not-exist', 'owner', 'host-only');
    expect(r.status).toBe(404);
  });
});
