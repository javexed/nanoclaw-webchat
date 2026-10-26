/**
 * GitHub Copilot connection routes: who may see and drive the sign-in, and
 * that every write needs the CSRF header. The tree under test has no Copilot
 * payload, so a permitted start answers "not installed" — which is also the
 * proof nothing was spawned.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WebchatServer } from './server.js';
import { httpRequest, PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

afterEach(resetServerModules);

describe('copilot connection routes', () => {
  let server: typeof import('./server.js');
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    ({ server, wc, port } = await startServer(PROXY_ENV, async (db) => {
      const { user, role } = seeder(db, '2026-10-23T00:00:00.000Z');
      await role('webchat:owner', 'owner', null);
      await role('webchat:admin', 'admin', null); // global admin
      await role('webchat:scoped', 'admin', 'ag-a'); // admin of one agent group only
      await user('webchat:nobody');
    }));
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (name: string) => ({ 'x-forwarded-user': name });
  const csrf = (name: string) => ({ ...as(name), 'x-webchat-csrf': '1' });

  it('owners and global admins read the status; nobody else does', async () => {
    for (const who of ['owner', 'admin']) {
      const r = await httpRequest(port, 'GET', '/api/workspace-credential/copilot', as(who));
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ running: false, available: false, connected: false });
    }
    for (const who of ['scoped', 'nobody']) {
      expect((await httpRequest(port, 'GET', '/api/workspace-credential/copilot', as(who))).status).toBe(403);
    }
  });

  it('every verb needs the CSRF header', async () => {
    for (const verb of ['start', 'cancel', 'disconnect']) {
      const r = await httpRequest(port, 'POST', `/api/workspace-credential/copilot/${verb}`, as('owner'));
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error).toMatch(/CSRF/);
    }
  });

  it('refuses non-admins before doing anything', async () => {
    for (const who of ['scoped', 'nobody']) {
      for (const verb of ['start', 'disconnect']) {
        const r = await httpRequest(port, 'POST', `/api/workspace-credential/copilot/${verb}`, csrf(who));
        expect(r.status).toBe(403);
      }
    }
  });

  it('an admin start or disconnect without the provider installed is a clear 409', async () => {
    for (const verb of ['start', 'disconnect']) {
      const r = await httpRequest(port, 'POST', `/api/workspace-credential/copilot/${verb}`, csrf('admin'));
      expect(r.status).toBe(409);
      expect(JSON.parse(r.body)).toMatchObject({ code: 'not-installed' });
    }
  });

  it('cancel with nothing running is a no-op', async () => {
    const r = await httpRequest(port, 'POST', '/api/workspace-credential/copilot/cancel', csrf('owner'));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ cancelled: false, running: false });
  });

  it('the workspace credential status carries a copilot block', async () => {
    const r = await httpRequest(port, 'GET', '/api/workspace-credential', as('owner'));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).copilot).toEqual({ available: false, connected: false });
  });

  it('Copilot cannot become the default provider while it is not installed', async () => {
    const r = await httpRequest(
      port,
      'PUT',
      '/api/workspace-provider',
      { ...csrf('owner'), 'content-type': 'application/json' },
      JSON.stringify({ provider: 'copilot' }),
    );
    expect(r.status).toBe(400);
  });

  it('the install status is owner-only', async () => {
    expect((await httpRequest(port, 'GET', '/api/copilot/install', as('owner'))).status).toBe(200);
    expect((await httpRequest(port, 'GET', '/api/copilot/install', as('nobody'))).status).toBe(403);
  });
});
