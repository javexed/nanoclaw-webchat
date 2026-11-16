/**
 * The forward_auth listener against a real HTTP server, with the database
 * and the route's edge stood in.
 */
import { createPublicKey, verify } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-gw-'));
const audits = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../../config.js')>()),
  DATA_DIR: DATA,
}));
vi.mock('../../../audit.js', () => ({ audit: (e: Record<string, unknown>) => audits.push(e) }));

const { internalHandler } = await import('./internal.js');
const { registerPublishingRoute, __clearPublishingRoutesForTest } = await import('./publishing.js');
import type { AppRoute } from '../routes.js';

const SECRET = 'k'.repeat(43);
const route: AppRoute = {
  id: '0b0f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e11',
  app: 'notes',
  workloadId: 'w1',
  agentGroupId: 'ag-1',
  service: 'web',
  port: 8080,
  kind: 'tailnet',
  who: 'agent-members',
  emails: [],
  ownerUserId: 'webchat:tailscale:bob@x.example',
  ticket: null,
  createdBy: 'agent:ag-1',
  createdAt: 0,
  updatedAt: 0,
  lastOpenedAt: null,
};
let live = true;
let routeOn = true;
let use: 'running' | 'starting' | 'failed' = 'running';
const opened: string[] = [];

const server = http.createServer(
  internalHandler(() => SECRET, {
    getRoute: async (id) => (id === route.id ? route : null),
    isLive: async () => live,
    userExists: async (u) => u.startsWith('webchat:tailscale:'),
    isOwner: async () => false,
    canAccessAgentGroup: async (u) => u === 'webchat:tailscale:alice@x.example',
    opened: async (r) => void opened.push(r.app),
    waking: async () => use,
  }),
);
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  __clearPublishingRoutesForTest();
  fs.rmSync(DATA, { recursive: true, force: true });
});
beforeEach(() => {
  live = true;
  routeOn = true;
  use = 'running';
  audits.length = 0;
  opened.length = 0;
  __clearPublishingRoutesForTest();
  registerPublishingRoute({
    kind: 'tailnet',
    label: 'your tailnet',
    enabled: async () => routeOn,
    hostnameFor: async (app) => `${app}.tail1.ts.net`,
    identify: async (req) => {
      const login = req.headers['tailscale-user-login'];
      return req.peer === '198.18.0.200' && typeof login === 'string'
        ? { userId: `webchat:tailscale:${login}`, displayName: login }
        : null;
    },
  });
});

const check = (headers: Record<string, string>, p = '/gateway/check', method = 'GET') =>
  fetch(`${base}${p}`, {
    method,
    redirect: 'manual',
    headers: {
      'X-NanoClaw-Gateway-Secret': SECRET,
      'X-NanoClaw-Route': route.id,
      'X-NanoClaw-Peer': '198.18.0.200',
      'X-Forwarded-Host': 'notes.tail1.ts.net',
      ...headers,
    },
  });

describe('gateway check', () => {
  it('a sleeping app answers a self-reloading Starting page while it wakes, then lets people in', async () => {
    use = 'starting';
    const page = await check({ 'Tailscale-User-Login': 'alice@x.example', Accept: 'text/html' });
    expect(page.status).toBe(503);
    expect(page.headers.get('retry-after')).toBe('3');
    expect(await page.text()).toMatch(/http-equiv="refresh".*Starting/s);
    expect(page.headers.get('x-nanoclaw-identity')).toBeNull();
    const api = await check({ 'Tailscale-User-Login': 'alice@x.example' });
    expect(await api.text()).toBe('Starting\n');
    use = 'running';
    expect((await check({ 'Tailscale-User-Login': 'alice@x.example' })).status).toBe(200);
  });

  it('a wake that failed answers that it could not start, without reloading', async () => {
    use = 'failed';
    const page = await check({ 'Tailscale-User-Login': 'alice@x.example', Accept: 'text/html' });
    expect(page.status).toBe(503);
    const body = await page.text();
    expect(body).toMatch(/could not start/);
    expect(body).not.toMatch(/refresh/);
  });

  it('wakes nothing for someone who may not open the app', async () => {
    use = 'starting';
    expect((await check({ 'Tailscale-User-Login': 'carol3@x.example' })).status).toBe(403);
    expect((await check({})).status).toBe(401);
  });

  it('reports an app as opened only when it let someone in', async () => {
    expect((await check({ 'Tailscale-User-Login': 'carol3@x.example' })).status).toBe(403);
    expect((await check({})).status).toBe(401);
    expect(opened).toEqual([]);
    expect((await check({ 'Tailscale-User-Login': 'alice@x.example' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(opened).toEqual(['notes']);
  });

  it('lets a member in with a signed identity for this app only', async () => {
    const r = await check({ 'Tailscale-User-Login': 'alice@x.example' });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-nanoclaw-user')).toBe('alice@x.example');
    expect(r.headers.get('x-nanoclaw-auth')).toBe('tailnet');
    const jwt = r.headers.get('x-nanoclaw-identity')!;
    const [h, p, s] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({
      sub: 'webchat:tailscale:alice@x.example',
      aud: 'notes.tail1.ts.net',
      amr: 'tailnet',
      iss: 'nanoclaw-gateway',
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(120);
    const keys = (await (await check({}, '/.nanoclaw/jwks.json')).json()) as { keys: Array<Record<string, string>> };
    const key = createPublicKey({ key: keys.keys[0], format: 'jwk' });
    expect(
      verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')),
    ).toBe(true);
  });

  it('refuses a non-member, and audits it once a minute', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await check({ 'Tailscale-User-Login': 'bob2@x.example' });
      expect(r.status).toBe(403);
      expect(r.headers.get('x-nanoclaw-identity')).toBeNull();
    }
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ type: 'workload-gateway.denied', effect: 'deny' });
  });

  it('answers 401 without a proven identity, and never redirects', async () => {
    const r = await check({ Accept: 'text/html', 'X-Forwarded-Uri': '//evil.example/' });
    expect(r.status).toBe(401);
    expect(r.headers.get('location')).toBeNull();
    const spoof = await check({ 'Tailscale-User-Login': 'alice@x.example', 'X-NanoClaw-Peer': '127.0.0.1' });
    expect(spoof.status).toBe(401);
  });

  it('needs the gateway secret', async () => {
    expect(
      (await check({ 'X-NanoClaw-Gateway-Secret': 'k'.repeat(42) + 'x', 'Tailscale-User-Login': 'alice@x.example' }))
        .status,
    ).toBe(403);
    expect((await check({ 'X-NanoClaw-Gateway-Secret': '' })).status).toBe(403);
  });

  it('on the port route, checks the host name and leaves the port to Caddy’s listener', async () => {
    __clearPublishingRoutesForTest();
    registerPublishingRoute({
      kind: 'port',
      label: 'a port',
      enabled: async () => true,
      hostnameFor: async () => 'node.tail1.ts.net:9001',
      identify: async (req) =>
        req.peer === '127.0.0.1' ? { userId: 'webchat:tailscale:alice@x.example', displayName: 'Alice' } : null,
    });
    route.kind = 'port';
    try {
      const at = (host: string, peer = '127.0.0.1') => check({ 'X-Forwarded-Host': host, 'X-NanoClaw-Peer': peer });
      const ok = await at('node.tail1.ts.net:9001');
      expect(ok.status).toBe(200);
      expect(ok.headers.get('x-nanoclaw-auth')).toBe('port');
      expect((await at('node.tail1.ts.net')).status).toBe(200);
      expect((await at('other.tail1.ts.net:9001')).status).toBe(404);
      expect((await at('node.tail1.ts.net:9001', '198.18.0.200')).status).toBe(401);
    } finally {
      route.kind = 'tailnet';
    }
  });

  it('serves nothing for an unpublished, stopped or switched-off app, or another host', async () => {
    expect((await check({ 'X-NanoClaw-Route': 'nope' })).status).toBe(404);
    live = false;
    expect((await check({ 'Tailscale-User-Login': 'alice@x.example' })).status).toBe(404);
    live = true;
    routeOn = false;
    expect((await check({ 'Tailscale-User-Login': 'alice@x.example' })).status).toBe(503);
    routeOn = true;
    expect(
      (await check({ 'Tailscale-User-Login': 'alice@x.example', 'X-Forwarded-Host': 'wiki.tail1.ts.net' })).status,
    ).toBe(404);
    expect((await check({ 'Tailscale-User-Login': 'alice@x.example' }, '/gateway/check', 'POST')).status).toBe(405);
  });
});
