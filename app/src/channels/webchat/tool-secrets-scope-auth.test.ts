/**
 * Authorization tests for the credential endpoints:
 *   GET/POST/DELETE /api/tool-secrets
 *   POST            /api/tool-secrets/isolation
 *   GET/POST/DELETE /api/deploy-keys
 *
 * Authorisation follows the SCOPE:
 *
 *   workspace     — install-wide, so owner / global admin only
 *   agent         — whoever administers THAT agent, scoped admins included
 *   user (self)   — anyone; a personal credential must be entered by its owner
 *   user (other)  — nobody, at any privilege level (owner included)
 *
 * That last row is asserted explicitly, owner included. The isolation toggle
 * follows the agent scope too: per-agent secrets do nothing until the agent is
 * `selective`.
 *
 * Tests lean on the 403-vs-anything-else split:
 *   403 = authorization refused (never reached the handler)
 *   other = past the gate (the handler ran; it may then fail on the vault,
 *           which is not wired up in tests — that failure still proves access)
 *
 * Identity is supplied per-request via a trusted proxy header. Same boot and
 * teardown pattern as scoped-skill-auth.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { WebchatServer } from './server.js';
import type { DbDriver } from '../../db/driver.js';
import { httpRequest, PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

afterEach(resetServerModules);

const now = '2026-07-30T00:00:00.000Z';
async function seed(db: DbDriver): Promise<void> {
  const { user, group, role } = seeder(db, now);
  await group('ag-test-a');
  await group('ag-test-b');
  // Pre-seed an owner so the first authenticated request doesn't auto-claim it.
  await role('webchat:owner', 'owner', null);
  await role('webchat:admina', 'admin', 'ag-test-a'); // scoped admin of A only
  await user('webchat:nobody'); // known user, but no role anywhere
}

describe('credential endpoints — scope-based authorization', () => {
  let server: typeof import('./server.js');
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    ({ server, wc, port } = await startServer(PROXY_ENV, seed));
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

    // Personal credentials are self-only at every privilege level — an admin acting on
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

  // ── /api/tool-secrets — username + password body ──────────────────────────
  describe('tool-secrets, username + password', () => {
    const post = (body: unknown) =>
      httpRequest(port, 'POST', '/api/tool-secrets?agentGroupId=ag-test-a', csrf('owner'), JSON.stringify(body));

    it('refuses an invalid pair without echoing either field', async () => {
      const r = await post({ hostPattern: 'caldav.icloud.com', basic: { username: 'who:ami', password: 'hunter2' } });
      expect(r.status).toBe(400);
      expect(r.body).toContain('colon');
      expect(r.body).not.toMatch(/who|ami|hunter2/);
    });

    // One POST per test: tool-secret writes are rate-limited per user.
    it('refuses basic mixed with a raw value', async () => {
      const r = await post({
        hostPattern: 'caldav.icloud.com',
        basic: { username: 'me', password: 'hunter2' },
        value: 'x',
      });
      expect(r.status).toBe(400);
      expect(r.body).not.toContain('hunter2');
    });

    it('refuses basic mixed with a scheme', async () => {
      const scheme = { headerName: 'X-Api-Key', valueFormat: '{value}' };
      const r = await post({
        hostPattern: 'caldav.icloud.com',
        basic: { username: 'me', password: 'hunter2' },
        scheme,
      });
      expect(r.status).toBe(400);
      expect(r.body).not.toContain('hunter2');
    });

    // A valid pair stands in for the value, so the next check is the host.
    it('a valid pair still needs a host', async () => {
      const r = await post({ basic: { username: 'me', password: 'hunter2' } });
      expect(r.status).toBe(400);
      expect(r.body).toContain('host and value are required');
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
