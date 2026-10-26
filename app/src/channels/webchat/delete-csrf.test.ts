/**
 * Destructive DELETEs need the CSRF header like every other write: without it
 * a cross-site request riding the owner's session could unwire an agent from a
 * room, or delete the agent. The request is refused before the handler runs,
 * so the agent and its wiring are untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { WebchatServer } from './server.js';
import type { DbDriver } from '../../db/driver.js';
import { httpRequest, PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

afterEach(resetServerModules);

async function seed(db: DbDriver): Promise<void> {
  const { group, role } = seeder(db, '2026-07-14T00:00:00.000Z');
  await group('ag-test-a');
  await role('webchat:owner', 'owner', null);
}

describe('DELETE routes require the CSRF header', () => {
  let server: typeof import('./server.js');
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    ({ server, wc, port } = await startServer(PROXY_ENV, seed));
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const owner = { 'x-forwarded-user': 'owner' };

  for (const route of ['/api/rooms/room-1/agents/ag-test-a', '/api/agents/ag-test-a']) {
    it(`${route} without the header is refused`, async () => {
      const r = await httpRequest(port, 'DELETE', route, owner);
      expect(r.status).toBe(403);
      expect(r.body).toMatch(/CSRF/);
    });
  }
});
