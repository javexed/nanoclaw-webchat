/**
 * Admin → Sign-in routes: who may use them, and the lockout rules.
 * The routes write .env under process.cwd(); cwd points at a scratch dir here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebchatServer } from './server.js';

const noopHooks = { onInbound: vi.fn(), onAction: vi.fn() };
const ISS = 'https://sso.example.org/realms/main';

async function boot(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  const migrations = await import('../../db/migrations/index.js');
  await migrations.runMigrations(conn.getDb());
  const db = conn.getDb();
  const now = new Date().toISOString();
  for (const id of ['webchat:owner@example.org', 'webchat:nobody@example.org', 'webchat:local-owner'])
    await db.run(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', NULL, ?)`, id, now);
  for (const id of ['webchat:owner@example.org', 'webchat:local-owner'])
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`,
      id,
      now,
    );
  const server = await import('./server.js');
  const wc = await server.startWebchatServer(noopHooks);
  const a = wc.http.address();
  return { server, wc, conn, port: typeof a === 'object' && a ? a.port : 0 };
}

describe('/api/webchat/signin', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let root: string;
  // The routes write process.env directly (as they must, to apply at once): put it back.
  let envBefore: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBefore = { ...process.env };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-routes-'));
    fs.writeFileSync(path.join(root, '.env'), '');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });

  afterEach(async () => {
    if (ctx?.wc) await ctx.server.stopWebchatServer(ctx.wc);
    await ctx?.conn.closeDb();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
    Object.assign(process.env, envBefore);
    vi.unstubAllGlobals();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const PROXY_ENV = {
    WEBCHAT_HOST: '127.0.0.1',
    WEBCHAT_PORT: '0',
    WEBCHAT_TOKEN: '',
    WEBCHAT_TAILSCALE: '',
    WEBCHAT_TRUSTED_PROXY_IPS: '127.0.0.1',
    WEBCHAT_TRUSTED_PROXY_HEADER: 'x-forwarded-user',
  };

  const call = async (method: string, what: string, who: string | null, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/webchat/signin${what}`, {
      method,
      headers: {
        ...(who ? { 'x-forwarded-user': who } : {}),
        'content-type': 'application/json',
        'x-webchat-csrf': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const envFile = () => fs.readFileSync(path.join(root, '.env'), 'utf8');

  it('shows the picture to an owner, with the redirect URI to register; refuses anyone else', async () => {
    ctx = await boot(PROXY_ENV);
    const r = await call('GET', '', 'owner@example.org');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      session: 'proxy',
      proxy: { enabled: true, ips: '127.0.0.1' },
      oidc: { enabled: false },
      tailscale: { enabled: false },
    });
    expect(r.body.oidc.redirectUri).toMatch(/\/auth\/oidc\/callback$/);
    expect((await call('GET', '', 'nobody@example.org')).status).toBe(403);
    expect((await call('PUT', '/tailscale', 'nobody@example.org', { enabled: true })).status).toBe(403);
  });

  it('turns Tailscale on and off at once, written to .env', async () => {
    ctx = await boot(PROXY_ENV);
    expect((await call('PUT', '/tailscale', 'owner@example.org', { enabled: true })).body.tailscale.enabled).toBe(true);
    expect(envFile()).toContain('WEBCHAT_TAILSCALE=true');
    expect(process.env.WEBCHAT_TAILSCALE).toBe('true');
    expect((await call('PUT', '/tailscale', 'owner@example.org', { enabled: false })).status).toBe(200);
    expect(envFile()).not.toContain('WEBCHAT_TAILSCALE');
  });

  it('will not turn off, or re-point, the method you are signed in with', async () => {
    ctx = await boot(PROXY_ENV);
    const off = await call('DELETE', '/proxy', 'owner@example.org');
    expect(off.status).toBe(400);
    expect(off.body.error).toMatch(/signed in with the trusted proxy/);
    const moved = await call('PUT', '/proxy', 'owner@example.org', { ips: '203.0.113.9' });
    expect(moved.status).toBe(400);
    // Saving the same settings again is not a change.
    expect((await call('PUT', '/proxy', 'owner@example.org', { ips: '127.0.0.1' })).status).toBe(200);
    expect(process.env.WEBCHAT_TRUSTED_PROXY_IPS).toBe('127.0.0.1');
  });

  it("refuses 'auto' for the proxy from the page", async () => {
    ctx = await boot(PROXY_ENV);
    const r = await call('PUT', '/proxy', 'owner@example.org', { ips: 'auto' });
    expect(r.status).toBe(400);
  });

  it('turns on OIDC for another provider from its discovery document, and records it', async () => {
    ctx = await boot(PROXY_ENV);
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url) === `${ISS}/.well-known/openid-configuration`)
          return new Response(
            JSON.stringify({
              issuer: ISS,
              jwks_uri: `${ISS}/certs`,
              authorization_endpoint: `${ISS}/auth`,
              token_endpoint: `${ISS}/token`,
            }),
            { status: 200 },
          );
        return realFetch(url, init);
      }),
    );
    const r = await call('PUT', '/oidc', 'owner@example.org', {
      provider: 'other',
      issuer: ISS,
      clientId: 'nanoclaw',
      name: 'Keycloak',
      clientSecret: 'shh-a-secret',
    });
    expect(r.status).toBe(200);
    expect(r.body.oidc).toMatchObject({ enabled: true, provider: 'other', name: 'Keycloak', secretSet: true });
    expect(JSON.stringify(r.body)).not.toContain('shh-a-secret');
    expect(envFile()).toContain(`WEBCHAT_OIDC_TOKEN_URL=${ISS}/token`);
    const info = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/info`).then((x) => x.json() as Promise<any>);
    expect(info.methods.oidcLogin).toBe(true);
    expect(info.oidcName).toBe('Keycloak');
  });

  it('as the localhost owner, only Tailscale can be turned on', async () => {
    ctx = await boot({ ...PROXY_ENV, WEBCHAT_TRUSTED_PROXY_IPS: '' });
    const proxy = await call('PUT', '/proxy', null, { ips: '10.0.0.5' });
    expect(proxy.status).toBe(400);
    expect(proxy.body.error).toMatch(/local owner/);
    expect(envFile()).not.toContain('WEBCHAT_TRUSTED_PROXY_IPS');
    const ts = await call('PUT', '/tailscale', null, { enabled: true });
    expect(ts.status).toBe(200);
    // …and the first tailnet identity to sign in becomes an owner, as in the setup wizard.
    const row = (await ctx.conn.getDb().get(`SELECT promote_first_tailscale_owner AS p FROM webchat_settings`)) as {
      p: number;
    };
    expect(Boolean(row.p)).toBe(true);
  });

  it('requires the CSRF header', async () => {
    ctx = await boot(PROXY_ENV);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/webchat/signin/tailscale`, {
      method: 'PUT',
      headers: { 'x-forwarded-user': 'owner@example.org', 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
    expect(envFile()).toBe('');
  });
});
