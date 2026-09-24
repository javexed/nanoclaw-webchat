/**
 * The generic install route, /api/install/:feature, and the per-feature paths
 * bound to the same handlers. GET only — a POST on a registered feature in the
 * composed tree would start a real chain (the skill is present, pnpm is on
 * PATH). The refusal codes are covered by install-engine.test.ts.
 *
 * Same boot and identity pattern as tool-secrets-scope-auth.test.ts.
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
): Promise<{ status: number; body: string }> {
  const http = await import('http');
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });
    r.on('error', reject);
    r.end();
  });
}

const portOf = (wc: { http: { address: () => unknown } }): number => {
  const a = wc.http.address();
  return typeof a === 'object' && a ? (a as { port: number }).port : 0;
};

describe('install routes', () => {
  let server: Awaited<ReturnType<typeof loadServerWithEnv>>['server'];
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    const loaded = await loadServerWithEnv({
      WEBCHAT_HOST: '127.0.0.1',
      WEBCHAT_PORT: '0',
      WEBCHAT_TOKEN: '',
      WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
      WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
    });
    server = loaded.server;
    const db = loaded.conn.getDb();
    const now = '2026-07-30T00:00:00.000Z';
    for (const id of ['webchat:owner', 'webchat:nobody'])
      await db.run(
        `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`,
        id,
        now,
      );
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES ('webchat:owner', 'owner', NULL, NULL, ?)`,
      now,
    );
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (name: string) => ({ 'x-forwarded-user': name });

  it('GET /api/install/:feature reports the engine status for a registered feature', async () => {
    const r = await httpRequest(port, 'GET', '/api/install/opencode', as('owner'));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({
      feature: 'opencode',
      running: false,
      installed: false,
      restartPending: false,
    });
  });

  it('the per-feature path is the same handler, bound', async () => {
    const generic = JSON.parse((await httpRequest(port, 'GET', '/api/install/pi', as('owner'))).body);
    const bound = JSON.parse((await httpRequest(port, 'GET', '/api/pi/install', as('owner'))).body);
    expect(bound).toEqual(generic);
    expect(bound.feature).toBe('pi');
  });

  it('an unknown feature is 404, not a crash or an empty status', async () => {
    const r = await httpRequest(port, 'GET', '/api/install/nope', as('owner'));
    expect(r.status).toBe(404);
  });

  it('is owner-only', async () => {
    const r = await httpRequest(port, 'GET', '/api/install/codex', as('nobody'));
    expect(r.status).toBe(403);
  });
});
