/**
 * Authorization tests for the credential endpoints:
 *   GET/POST/DELETE /api/tool-secrets
 *   POST            /api/tool-secrets/isolation
 *   GET/POST/DELETE /api/deploy-keys
 *
 * These were all gated on owner-or-global-admin, which locked a scoped admin
 * out of the very agents they administer. Authorisation now follows the SCOPE:
 *
 *   workspace     — install-wide, so owner / global admin only
 *   agent         — whoever administers THAT agent, scoped admins included
 *   user (self)   — anyone; a personal credential must be entered by its owner
 *   user (other)  — nobody, at any privilege level (owner included)
 *
 * That last row is the subtle one: an owner USED to be able to manage someone
 * else's personal credential and deliberately no longer can, so it is asserted
 * explicitly rather than left to drift back.
 *
 * The isolation toggle matters as much as the secrets themselves — per-agent
 * secrets do nothing until the agent is flipped to `selective`, so leaving that
 * endpoint owner-only would have made the rest of the fix inert.
 *
 * Tests lean on the 403-vs-anything-else split:
 *   403 = authorization refused (never reached the handler)
 *   other = past the gate (the handler ran; it may then fail on the vault,
 *           which is not wired up in tests — that failure still proves access)
 *
 * Identity is supplied per-request via a trusted proxy header. Same boot and
 * teardown pattern as scoped-skill-auth.test.ts.
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
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
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
  group('ag-test-a');
  group('ag-test-b');
  // Pre-seed an owner so the first authenticated request doesn't auto-claim it.
  role('webchat:owner', 'owner', null);
  role('webchat:admina', 'admin', 'ag-test-a'); // scoped admin of A only
  user('webchat:nobody'); // known user, but no role anywhere
}

describe('credential endpoints — scope-based authorization', () => {
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
    seed(loaded.conn.getDb());
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (name: string) => ({ 'x-forwarded-user': name });
  const csrf = (name: string) => ({ ...as(name), 'x-webchat-csrf': '1', 'content-type': 'application/json' });

  // ── /api/tool-secrets — agent scope ───────────────────────────────────────
  describe('tool-secrets, agent scope', () => {
    it('scoped admin reaches an agent they administer', async () => {
      const r = await httpRequest(port, 'GET', '/api/tool-secrets?agentGroupId=ag-test-a', as('admina'));
      expect(r.status).not.toBe(403);
    });

    it('scoped admin is refused on an agent they do NOT administer', async () => {
      const r = await httpRequest(port, 'GET', '/api/tool-secrets?agentGroupId=ag-test-b', as('admina'));
      expect(r.status).toBe(403);
    });

    it('a user with no role anywhere is refused', async () => {
      const r = await httpRequest(port, 'GET', '/api/tool-secrets?agentGroupId=ag-test-a', as('nobody'));
      expect(r.status).toBe(403);
    });

    it('owner reaches any agent', async () => {
      const r = await httpRequest(port, 'GET', '/api/tool-secrets?agentGroupId=ag-test-b', as('owner'));
      expect(r.status).not.toBe(403);
    });
  });

  // ── /api/tool-secrets — workspace scope stays install-wide ────────────────
  describe('tool-secrets, workspace scope', () => {
    it('a scoped admin is refused (install-wide, not theirs to set)', async () => {
      const r = await httpRequest(port, 'GET', '/api/tool-secrets', as('admina'));
      expect(r.status).toBe(403);
    });

    it('owner is allowed', async () => {
      const r = await httpRequest(port, 'GET', '/api/tool-secrets', as('owner'));
      expect(r.status).not.toBe(403);
    });
  });

  // ── /api/tool-secrets — user scope is self-only, for everyone ─────────────
  describe('tool-secrets, user scope', () => {
    it('a user may manage their OWN personal credential', async () => {
      const r = await httpRequest(
        port,
        'GET',
        '/api/tool-secrets?agentGroupId=ag-test-a&userId=webchat%3Aadmina',
        as('admina'),
      );
      expect(r.status).not.toBe(403);
    });

    it("a scoped admin may NOT manage someone else's personal credential", async () => {
      const r = await httpRequest(
        port,
        'GET',
        '/api/tool-secrets?agentGroupId=ag-test-a&userId=webchat%3Anobody',
        as('admina'),
      );
      expect(r.status).toBe(403);
      expect(r.body).toContain('your own credentials');
    });

    // Regression lock: an owner USED to pass this gate. Personal credentials are
    // deliberately self-only at every privilege level — an admin acting on
    // someone's behalf would have to handle that person's token, which is the
    // exact thing per-user credentials exist to prevent.
    it("an OWNER may NOT manage someone else's personal credential either", async () => {
      const r = await httpRequest(
        port,
        'GET',
        '/api/tool-secrets?agentGroupId=ag-test-a&userId=webchat%3Anobody',
        as('owner'),
      );
      expect(r.status).toBe(403);
      expect(r.body).toContain('your own credentials');
    });
  });

  // ── /api/tool-secrets/isolation — per-agent toggle ────────────────────────
  describe('tool-secrets isolation toggle', () => {
    const body = JSON.stringify({ isolated: true });

    it('scoped admin may flip an agent they administer', async () => {
      const r = await httpRequest(
        port,
        'POST',
        '/api/tool-secrets/isolation?agentGroupId=ag-test-a',
        csrf('admina'),
        body,
      );
      // Past both the CSRF gate and authorization. The vault call behind it is
      // not wired up under test, so anything other than 403/400 proves access.
      expect(r.status).not.toBe(403);
      expect(r.status).not.toBe(400);
    });

    it('scoped admin is refused on an agent they do NOT administer', async () => {
      const r = await httpRequest(
        port,
        'POST',
        '/api/tool-secrets/isolation?agentGroupId=ag-test-b',
        csrf('admina'),
        body,
      );
      expect(r.status).toBe(403);
    });

    it('a user with no role anywhere is refused', async () => {
      const r = await httpRequest(
        port,
        'POST',
        '/api/tool-secrets/isolation?agentGroupId=ag-test-a',
        csrf('nobody'),
        body,
      );
      expect(r.status).toBe(403);
    });

    it('CSRF is the outermost gate — a missing header is refused before anything else', async () => {
      const r = await httpRequest(
        port,
        'POST',
        '/api/tool-secrets/isolation?agentGroupId=ag-test-a',
        { ...as('admina'), 'content-type': 'application/json' },
        body,
      );
      expect(r.status).toBe(403);
      expect(r.body).toContain('CSRF');
    });

    it('CSRF is checked before group existence, so an unknown id is not probeable cross-site', async () => {
      const r = await httpRequest(
        port,
        'POST',
        '/api/tool-secrets/isolation?agentGroupId=does-not-exist',
        { ...as('owner'), 'content-type': 'application/json' },
        body,
      );
      expect(r.status).toBe(403);
      expect(r.body).toContain('CSRF');
    });
  });

  // ── /api/deploy-keys — per-agent resource ─────────────────────────────────
  describe('deploy-keys', () => {
    it('scoped admin reaches an agent they administer', async () => {
      const r = await httpRequest(port, 'GET', '/api/deploy-keys?agentGroupId=ag-test-a', as('admina'));
      expect(r.status).toBe(200);
    });

    it('scoped admin is refused on an agent they do NOT administer', async () => {
      const r = await httpRequest(port, 'GET', '/api/deploy-keys?agentGroupId=ag-test-b', as('admina'));
      expect(r.status).toBe(403);
    });

    it('a user with no role anywhere is refused', async () => {
      const r = await httpRequest(port, 'GET', '/api/deploy-keys?agentGroupId=ag-test-a', as('nobody'));
      expect(r.status).toBe(403);
    });

    it('owner reaches any agent', async () => {
      const r = await httpRequest(port, 'GET', '/api/deploy-keys?agentGroupId=ag-test-b', as('owner'));
      expect(r.status).toBe(200);
    });
  });
});
