/**
 * Join over SSH is for owners and global admins, and writes need the CSRF
 * header. With the machine listener off (no NANOCLAW_MACHINE_PORT here), an
 * allowed caller gets 409 — which shows the guards let them through.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbDriver } from '../../db/driver.js';
import type { WebchatServer } from './server.js';
import { httpRequest, PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

afterEach(resetServerModules);

const now = '2026-11-02T00:00:00.000Z';
async function seed(db: DbDriver): Promise<void> {
  const { user, group, role } = seeder(db, now);
  await group('ag-x');
  await role('webchat:owner', 'owner', null);
  await role('webchat:gadmin', 'admin', null);
  await role('webchat:scoped', 'admin', 'ag-x');
  await user('webchat:nobody');
}

describe('Join over SSH routes', () => {
  let server: typeof import('./server.js');
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    ({ server, wc, port } = await startServer(PROXY_ENV, seed));
  });
  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const post = (path: string, who: string, csrf = true) =>
    httpRequest(
      port,
      'POST',
      path,
      { 'x-forwarded-user': who, 'content-type': 'application/json', ...(csrf ? { 'x-webchat-csrf': '1' } : {}) },
      JSON.stringify({ host: '10.0.0.10', port: 22 }),
    );

  for (const path of ['/api/scaling/machines/ssh/probe', '/api/scaling/machines/ssh/join']) {
    it(`${path}: owners and global admins only, CSRF required`, async () => {
      expect((await post(path, 'scoped')).status).toBe(403);
      expect((await post(path, 'nobody')).status).toBe(403);
      expect((await post(path, 'owner', false)).status).toBe(403);
      expect((await post(path, 'owner')).status).toBe(409);
      expect((await post(path, 'gadmin')).status).toBe(409);
    });
  }
});
