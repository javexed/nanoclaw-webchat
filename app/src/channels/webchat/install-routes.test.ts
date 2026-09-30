/**
 * The generic install route, /api/install/:feature, and the per-feature paths
 * bound to the same handlers. GET only — a POST on a registered feature in the
 * composed tree would start a real chain (the skill is present, pnpm is on
 * PATH). The refusal codes are covered by install-engine.test.ts.
 *
 * Same boot and identity pattern as tool-secrets-scope-auth.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { WebchatServer } from './server.js';
import { httpRequest, PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

afterEach(resetServerModules);

describe('install routes', () => {
  let server: typeof import('./server.js');
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    ({ server, wc, port } = await startServer(PROXY_ENV, async (db) => {
      const { user, role } = seeder(db, '2026-07-30T00:00:00.000Z');
      await role('webchat:owner', 'owner', null);
      await user('webchat:nobody');
    }));
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
