/**
 * Authorization tests for the per-agent scoped-skill content endpoints
 * (GET/PUT /api/agents/:id/skills/scoped/:name/content).
 *
 * The rule: a scoped skill lives in ONE agent's own dir, so a per-group admin
 * of that agent may view AND edit it — but NOT a skill on an agent they don't
 * administer (that would let them reach an agent they can't otherwise touch).
 * Owner / global admin reach any agent. Non-admins are refused outright.
 *
 * The tests never create a skill on disk — they lean on the 403-vs-404 split:
 *   403 = authorization refused (never reached the handler)
 *   404 = authorized, but that skill file doesn't exist (handler ran)
 * so a 404 proves the caller passed the gate.
 *
 * Identity is supplied per-request via a trusted proxy header, so each request
 * can act as a different user. Same boot/teardown pattern as server.auth.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { WebchatServer } from './server.js';
import type { DbDriver } from '../../db/driver.js';
import { httpRequest, PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

afterEach(resetServerModules);

async function seed(db: DbDriver): Promise<void> {
  const { user, group, role } = seeder(db, '2026-07-14T00:00:00.000Z');
  await group('ag-test-a');
  await group('ag-test-b');
  // Pre-seed an owner so the first authenticated request doesn't auto-claim it.
  await role('webchat:owner', 'owner', null);
  await role('webchat:admina', 'admin', 'ag-test-a'); // scoped admin of A only
  await user('webchat:nobody'); // known user, but no role anywhere
}

const SCOPED = (g: string) => `/api/agents/${g}/skills/scoped/nonexistent-skill/content`;

describe('scoped-skill content endpoints — authorization', () => {
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

  it('scoped admin reaches their own agent (404 = past the gate, no such skill)', async () => {
    const r = await httpRequest(port, 'GET', SCOPED('ag-test-a'), as('admina'));
    expect(r.status).toBe(404);
  });

  it('scoped admin is refused on an agent they do NOT administer', async () => {
    const r = await httpRequest(port, 'GET', SCOPED('ag-test-b'), as('admina'));
    expect(r.status).toBe(403);
  });

  it('a non-admin user is refused', async () => {
    const r = await httpRequest(port, 'GET', SCOPED('ag-test-a'), as('nobody'));
    expect(r.status).toBe(403);
  });

  it('owner / global admin reaches any agent', async () => {
    const r = await httpRequest(port, 'GET', SCOPED('ag-test-b'), as('owner'));
    expect(r.status).toBe(404);
  });

  it('PUT without the CSRF header is refused even for the right admin', async () => {
    const r = await httpRequest(
      port,
      'PUT',
      SCOPED('ag-test-a'),
      { ...as('admina'), 'content-type': 'application/json' },
      JSON.stringify({ content: 'x' }),
    );
    expect(r.status).toBe(403);
  });

  it('PUT with CSRF by the right admin passes the gate (404 = no such skill to overwrite)', async () => {
    const r = await httpRequest(
      port,
      'PUT',
      SCOPED('ag-test-a'),
      { ...as('admina'), 'content-type': 'application/json', 'x-webchat-csrf': '1' },
      JSON.stringify({ content: '---\ndescription: test\n---\nbody' }),
    );
    expect(r.status).toBe(404);
  });

  it('PUT with CSRF on an unadministered agent is refused before any write', async () => {
    const r = await httpRequest(
      port,
      'PUT',
      SCOPED('ag-test-b'),
      { ...as('admina'), 'content-type': 'application/json', 'x-webchat-csrf': '1' },
      JSON.stringify({ content: '---\ndescription: test\n---\nbody' }),
    );
    expect(r.status).toBe(403);
  });
});
