/**
 * GitHub Copilot connection routes: who may see and drive the sign-in, and
 * that every write needs the CSRF header. The tree under test has no Copilot
 * payload, so a permitted start answers "not installed" — which is also the
 * proof nothing was spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebchatServer } from './server.js';
import { httpRequest, PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

// Off by default (the tree has no payload); the cases below switch them on.
let copilotInstalled = false;
let grokInstalled = false;
vi.mock('./server/providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./server/providers.js')>()),
  copilotAvailable: () => copilotInstalled,
  grokAvailable: () => grokInstalled,
}));

// The sign-in state the routes see: whether one is busy, and which viewer
// each progress read was made for.
let loginBusy = false;
const progressViewers: (string | undefined)[] = [];
vi.mock('./server/copilot-connect.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./server/copilot-connect.js')>();
  return {
    ...real,
    copilotLoginBusy: () => loginBusy,
    getCopilotLoginProgress: (viewerId?: string) => {
      progressViewers.push(viewerId);
      return real.getCopilotLoginProgress(viewerId);
    },
  };
});

afterEach(async () => {
  copilotInstalled = false;
  grokInstalled = false;
  loginBusy = false;
  progressViewers.length = 0;
  await resetServerModules();
});

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

  describe('with the provider installed', () => {
    beforeEach(() => {
      copilotInstalled = true;
      grokInstalled = true;
    });

    const putHarness = (who: string, provider: string) =>
      httpRequest(
        port,
        'PUT',
        '/api/agents/ag-a/provider',
        { ...csrf(who), 'content-type': 'application/json' },
        JSON.stringify({ provider }),
      );

    it('putting an agent on Copilot is authorized exactly like any other harness', async () => {
      for (const who of ['owner', 'admin', 'scoped', 'nobody']) {
        const statuses: Record<string, number> = {};
        for (const provider of ['copilot', 'grok']) {
          statuses[provider] = (await putHarness(who, provider)).status;
          await putHarness('owner', 'claude');
        }
        expect(statuses.copilot, who).toBe(statuses.grok);
        expect(statuses.copilot, who).toBe(who === 'nobody' ? 403 : 200);
      }
    });

    it('disconnect is refused while a sign-in is in progress', async () => {
      loginBusy = true;
      const r = await httpRequest(port, 'POST', '/api/workspace-credential/copilot/disconnect', csrf('admin'));
      expect(r.status).toBe(409);
      expect(JSON.parse(r.body)).toMatchObject({ code: 'login-running' });
    });
  });

  it('sign-in progress is read for the requesting admin', async () => {
    await httpRequest(port, 'GET', '/api/workspace-credential/copilot', as('admin'));
    await httpRequest(port, 'POST', '/api/workspace-credential/copilot/cancel', csrf('owner'));
    expect(progressViewers).toEqual(['webchat:admin', 'webchat:owner']);
  });

  it('the install status is owner-only', async () => {
    expect((await httpRequest(port, 'GET', '/api/copilot/install', as('owner'))).status).toBe(200);
    expect((await httpRequest(port, 'GET', '/api/copilot/install', as('nobody'))).status).toBe(403);
  });
});
