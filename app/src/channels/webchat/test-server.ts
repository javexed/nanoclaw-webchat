/**
 * Test-only: boot the real webchat server on an ephemeral loopback port over a
 * fresh, migrated test DB. Everything is imported after vi.resetModules() so a
 * test and the server share one module instance (and so one DB connection).
 */
import http from 'http';
import { vi } from 'vitest';

import type { DbDriver } from '../../db/driver.js';
import type { WebchatServerHooks } from './server.js';

export const noopHooks: WebchatServerHooks = { onInbound: vi.fn(), onAction: vi.fn() };

/** Loopback with no auth method configured: every request is the local owner. */
export const LOOPBACK_ENV = {
  WEBCHAT_HOST: '127.0.0.1',
  WEBCHAT_PORT: '0',
  WEBCHAT_TOKEN: '',
  WEBCHAT_TAILSCALE: '',
  WEBCHAT_TRUSTED_PROXY_IPS: '',
};

/** Identity per request from the `x-forwarded-user` header, trusted from loopback. */
export const PROXY_ENV = {
  ...LOOPBACK_ENV,
  WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
  WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
};

/** Stub exactly `env` (undefined stubs as ''), then load a fresh migrated DB and server module. */
export async function loadServer(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v ?? '');
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  await migrations.runMigrations(conn.getDb());
  return { server: await import('./server.js'), conn };
}

/** loadServer, run `seed` against the DB, then start listening. */
export async function startServer(env: Record<string, string | undefined>, seed?: (db: DbDriver) => Promise<void>) {
  const { server, conn } = await loadServer(env);
  if (seed) await seed(conn.getDb());
  const wc = await server.startWebchatServer(noopHooks);
  return { server, conn, wc, port: portOf(wc) };
}

/** afterEach: drop env stubs, close the DB (if one was opened), forget loaded modules. */
export async function resetServerModules(): Promise<void> {
  vi.unstubAllEnvs();
  try {
    const conn = await import('../../db/connection.js');
    await conn.closeDb();
  } catch {
    // no DB was opened
  }
  vi.resetModules();
}

export function portOf(wc: { http: { address: () => unknown } }): number {
  const addr = wc.http.address() as { port: number } | string | null;
  if (!addr || typeof addr !== 'object') throw new Error('server has no address');
  return addr.port;
}

export function httpRequest(
  port: number,
  method: string,
  reqPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
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

/** Row builders for the identity tables; `role` creates its user and scoped group if missing. */
export function seeder(db: DbDriver, now: string) {
  const user = async (id: string) =>
    await db.run(
      `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`,
      id,
      now,
    );
  const group = async (id: string, name = id) =>
    await db.run(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`,
      id,
      name,
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
  return { user, group, role };
}
