/**
 * "Sign in with Microsoft" and explicit identity linking: the login flow
 * (oidc-login.ts), the session cookie as an auth method (auth.ts), and the
 * link rules (signins.ts).
 *
 * auth.ts reads its settings at module load, so each test loads a fresh module
 * graph with its own env (same harness as auth.test.ts).
 */
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import type { IncomingMessage } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ISS = 'https://login.microsoftonline.com/test-tenant/v2.0';
const AUD = 'test-client-id';
const JWKS_URI = 'https://jwks.test/keys';
const TOKEN_URI = 'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token';
const KID = 'kid-a';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(key.publicKey.export({ format: 'jwk' }) as object), kid: KID, alg: 'RS256', use: 'sig' };
const b64u = (x: string | Buffer): string => Buffer.from(x).toString('base64url');
const nowS = (): number => Math.floor(Date.now() / 1000);

function mintIdToken(claims: Record<string, unknown>): string {
  const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(cryptoSign('sha256', Buffer.from(`${h}.${p}`), key.privateKey))}`;
}
const idClaims = (nonce: string, who = 'Jane.Doe@Example.com'): Record<string, unknown> => ({
  iss: ISS,
  aud: AUD,
  exp: nowS() + 3600,
  nbf: nowS() - 60,
  nonce,
  preferred_username: who,
  name: 'Jane Doe',
});

function fakeReq(opts: { remoteAddress?: string; headers?: Record<string, string> } = {}): IncomingMessage {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? '203.0.113.7' },
    headers: { host: 'central.example', ...(opts.headers ?? {}) },
  } as unknown as IncomingMessage;
}

const ENTRA = {
  WEBCHAT_TOKEN: '',
  WEBCHAT_TAILSCALE: '',
  WEBCHAT_TRUSTED_PROXY_IPS: '',
  WEBCHAT_OIDC_ISSUER: ISS,
  WEBCHAT_OIDC_AUDIENCE: AUD,
  WEBCHAT_OIDC_JWKS_URI: JWKS_URI,
  WEBCHAT_OIDC_LOGIN: '',
};

/** What the token endpoint hands back for the next exchange. */
let nextIdToken: (body: URLSearchParams) => string = () => '';
let lastTokenBody: URLSearchParams | null = null;

async function load(env: Record<string, string> = ENTRA) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const conn = await import('../../db/connection.js');
  await conn.initTestDb();
  const { runMigrations } = await import('../../db/migrations/index.js');
  await runMigrations(conn.getDb());
  return {
    auth: await import('./auth.js'),
    login: await import('./oidc-login.js'),
    signins: await import('./signins.js'),
    db: conn.getDb(),
  };
}

beforeEach(() => {
  lastTokenBody = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) === JWKS_URI) return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
      if (String(url) === TOKEN_URI) {
        lastTokenBody = new URLSearchParams(String(init?.body ?? ''));
        return { ok: true, status: 200, json: async () => ({ id_token: nextIdToken(lastTokenBody!) }) };
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  try {
    const conn = await import('../../db/connection.js');
    await conn.closeDb();
  } catch {
    /* ignore */
  }
  vi.resetModules();
});

/** Run the flow: begin, pull state/nonce out of the Microsoft URL, return as Microsoft would. */
async function roundTrip(login: Awaited<ReturnType<typeof load>>['login'], who?: string, linkFrom?: string) {
  const to = new URL(login.beginLogin({ redirectUri: 'https://central.example/auth/microsoft/callback', linkFrom }));
  const state = to.searchParams.get('state')!;
  const nonce = to.searchParams.get('nonce')!;
  nextIdToken = () => mintIdToken(idClaims(nonce, who));
  return { to, result: await login.completeLogin(new URLSearchParams({ code: 'the-code', state })) };
}

describe('Sign in with Microsoft — the flow', () => {
  it('sends the browser to Microsoft with PKCE, a state and a nonce', async () => {
    const { login } = await load();
    const to = new URL(login.beginLogin({ redirectUri: 'https://central.example/auth/microsoft/callback' }));
    expect(to.origin + to.pathname).toBe('https://login.microsoftonline.com/test-tenant/oauth2/v2.0/authorize');
    expect(to.searchParams.get('client_id')).toBe(AUD);
    expect(to.searchParams.get('response_type')).toBe('code');
    expect(to.searchParams.get('redirect_uri')).toBe('https://central.example/auth/microsoft/callback');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(to.searchParams.get('state')).toBeTruthy();
    expect(to.searchParams.get('nonce')).toBeTruthy();
    expect(to.searchParams.get('prompt')).toBeNull();
    // Linking always shows the account picker.
    expect(
      new URL(login.beginLogin({ redirectUri: 'https://x/cb', linkFrom: 'webchat:tailscale:jane' })).searchParams.get(
        'prompt',
      ),
    ).toBe('select_account');
  });

  it('redeems the code with the PKCE verifier and returns the verified identity', async () => {
    const { login } = await load();
    const { result } = await roundTrip(login);
    expect(result).toMatchObject({ ok: true, identity: { identity: 'Jane.Doe@Example.com', displayName: 'Jane Doe' } });
    expect(lastTokenBody!.get('code')).toBe('the-code');
    expect(lastTokenBody!.get('code_verifier')).toMatch(/^[\w-]{43}$/);
    expect(lastTokenBody!.get('client_secret')).toBeNull(); // none configured: a public client
  });

  it('refuses an id token minted for a different attempt (nonce), and a state used twice', async () => {
    const { login } = await load();
    const to = new URL(login.beginLogin({ redirectUri: 'https://central.example/auth/microsoft/callback' }));
    const state = to.searchParams.get('state')!;
    nextIdToken = () => mintIdToken(idClaims('someone-elses-nonce'));
    expect(await login.completeLogin(new URLSearchParams({ code: 'c', state }))).toMatchObject({
      ok: false,
      reason: 'token',
      detail: 'nonce',
    });
    expect(await login.completeLogin(new URLSearchParams({ code: 'c', state }))).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it("reports Microsoft's own refusal", async () => {
    const { login } = await load();
    const r = await login.completeLogin(
      new URLSearchParams({ error: 'access_denied', error_description: 'The user cancelled.' }),
    );
    expect(r).toMatchObject({ ok: false, reason: 'refused', detail: 'The user cancelled.' });
  });

  it('the button is off without Entra settings, and when WEBCHAT_OIDC_LOGIN=false', async () => {
    expect((await load({ ...ENTRA, WEBCHAT_OIDC_ISSUER: '' })).auth.oidcLoginEnabled()).toBe(false);
    expect((await load({ ...ENTRA, WEBCHAT_OIDC_LOGIN: 'false' })).auth.oidcLoginEnabled()).toBe(false);
    expect((await load()).auth.oidcLoginEnabled()).toBe(true);
  });
});

describe('Sign in with Microsoft — the session cookie', () => {
  it('authenticates the browser as the Microsoft identity', async () => {
    const { auth, signins } = await load();
    const token = await signins.createSigninSession('webchat:jane.doe@example.com', 'Jane Doe');
    const r = await auth.authenticateRequest(fakeReq({ headers: { cookie: `other=1; nanoclaw_session=${token}` } }));
    expect(r).toMatchObject({ ok: true, source: 'oidc', userId: 'webchat:jane.doe@example.com', viaSession: true });
  });

  it('does not let another origin ride the cookie on a WebSocket upgrade', async () => {
    const { auth, signins } = await load();
    const token = await signins.createSigninSession('webchat:jane.doe@example.com', 'Jane Doe');
    const cookie = `nanoclaw_session=${token}`;
    const cross = await auth.authenticateRequest(
      fakeReq({ headers: { cookie, upgrade: 'websocket', origin: 'https://evil.example' } }),
    );
    expect(cross.ok).toBe(false);
    const same = await auth.authenticateRequest(
      fakeReq({ headers: { cookie, upgrade: 'websocket', origin: 'https://central.example' } }),
    );
    expect(same.ok).toBe(true);
  });

  it('ends with its expiry, on sign-out, and when Entra is no longer configured', async () => {
    const { auth, signins } = await load();
    const t1 = await signins.createSigninSession(
      'webchat:jane.doe@example.com',
      'Jane Doe',
      Date.now() - signins.SESSION_TTL_MS - 1,
    );
    expect((await auth.authenticateRequest(fakeReq({ headers: { cookie: `nanoclaw_session=${t1}` } }))).ok).toBe(false);
    const t2 = await signins.createSigninSession('webchat:jane.doe@example.com', 'Jane Doe');
    await signins.deleteSigninSession(t2);
    expect((await auth.authenticateRequest(fakeReq({ headers: { cookie: `nanoclaw_session=${t2}` } }))).ok).toBe(false);
    // Entra removed: sessions stop authenticating (the stored rows are simply ignored).
    const off = await load({ ...ENTRA, WEBCHAT_OIDC_ISSUER: '' });
    const t3 = await off.signins.createSigninSession('webchat:jane.doe@example.com', 'Jane Doe');
    expect((await off.auth.authenticateRequest(fakeReq({ headers: { cookie: `nanoclaw_session=${t3}` } }))).ok).toBe(
      false,
    );
  });

  it('stores only a hash of the token, and the cookie is HttpOnly and SameSite=Lax', async () => {
    const { signins, db } = await load();
    const token = await signins.createSigninSession('webchat:jane.doe@example.com', 'Jane Doe');
    const row = (await db.get(`SELECT token_hash FROM webchat_signin_sessions`)) as { token_hash: string };
    expect(row.token_hash).not.toContain(token);
    const c = signins.sessionCookie(token, true);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Secure/);
    expect(signins.sessionCookie(token, false)).not.toMatch(/Secure/);
  });
});

describe('Explicit identity linking', () => {
  async function seedUser(db: Awaited<ReturnType<typeof load>>['db'], id: string, createdAt: string): Promise<void> {
    await db.run(
      `INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'webchat', ?, ?)`,
      id,
      id,
      createdAt,
    );
  }

  it('the older identity stays the account; a linked sign-in authenticates as it', async () => {
    const { auth, signins, db } = await load();
    await seedUser(db, 'webchat:tailscale:jane@example.com', '2026-01-01T00:00:00Z');
    await seedUser(db, 'webchat:jane.doe@example.com', '2026-09-01T00:00:00Z');
    const r = await signins.linkIdentities('webchat:jane.doe@example.com', 'webchat:tailscale:jane@example.com');
    expect(r).toEqual({
      ok: true,
      primary: 'webchat:tailscale:jane@example.com',
      alias: 'webchat:jane.doe@example.com',
    });

    const token = await signins.createSigninSession('webchat:jane.doe@example.com', 'Jane Doe');
    const a = await auth.authenticateRequest(fakeReq({ headers: { cookie: `nanoclaw_session=${token}` } }));
    expect(a).toMatchObject({
      ok: true,
      userId: 'webchat:tailscale:jane@example.com',
      signedInAs: 'webchat:jane.doe@example.com',
    });

    // Unlinking applies on the next request: the session stored the raw identity.
    expect(await signins.unlinkIdentity('webchat:tailscale:jane@example.com', 'webchat:jane.doe@example.com')).toBe(
      true,
    );
    const b = await auth.authenticateRequest(fakeReq({ headers: { cookie: `nanoclaw_session=${token}` } }));
    expect(b).toMatchObject({ ok: true, userId: 'webchat:jane.doe@example.com' });
  });

  it('refuses to make an identity that holds a role, or has sign-ins of its own, into an alias', async () => {
    const { signins, db } = await load();
    await seedUser(db, 'webchat:tailscale:jane@example.com', '2026-01-01T00:00:00Z');
    await seedUser(db, 'webchat:jane.doe@example.com', '2026-09-01T00:00:00Z');
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', NULL, NULL, ?)`,
      'webchat:jane.doe@example.com',
      '2026-09-02T00:00:00Z',
    );
    expect(await signins.linkIdentities('webchat:jane.doe@example.com', 'webchat:tailscale:jane@example.com')).toEqual({
      ok: false,
      reason: 'has-roles',
    });

    await seedUser(db, 'webchat:other@example.com', '2026-09-03T00:00:00Z');
    await seedUser(db, 'webchat:tailscale:laptop2', '2026-09-04T00:00:00Z');
    expect((await signins.linkIdentities('webchat:other@example.com', 'webchat:tailscale:laptop2')).ok).toBe(true);
    // other@ is now an account with a sign-in; it cannot itself become someone's alias.
    expect(await signins.linkIdentities('webchat:tailscale:jane@example.com', 'webchat:other@example.com')).toEqual({
      ok: false,
      reason: 'has-links',
    });
    expect(await signins.linkIdentities('webchat:other@example.com', 'webchat:tailscale:laptop2')).toEqual({
      ok: false,
      reason: 'same',
    });
  });

  it('a third sign-in joins the existing account, never forming a chain', async () => {
    const { signins, db } = await load();
    await seedUser(db, 'webchat:tailscale:jane@example.com', '2026-01-01T00:00:00Z');
    await seedUser(db, 'webchat:jane.doe@example.com', '2026-09-01T00:00:00Z');
    await seedUser(db, 'webchat:jane@contoso.example', '2026-09-05T00:00:00Z');
    await signins.linkIdentities('webchat:jane.doe@example.com', 'webchat:tailscale:jane@example.com');
    // Signed in as the ALIAS, linking a third: it joins the account the alias belongs to.
    expect(await signins.linkIdentities('webchat:jane.doe@example.com', 'webchat:jane@contoso.example')).toEqual({
      ok: true,
      primary: 'webchat:tailscale:jane@example.com',
      alias: 'webchat:jane@contoso.example',
    });
    expect((await signins.listLinks('webchat:tailscale:jane@example.com')).map((l) => l.aliasUserId).sort()).toEqual([
      'webchat:jane.doe@example.com',
      'webchat:jane@contoso.example',
    ]);
  });

  it('a Microsoft sign-in completed while linking joins the account that started it', async () => {
    const { login, signins, db } = await load();
    await seedUser(db, 'webchat:tailscale:jane@example.com', '2026-01-01T00:00:00Z');
    const { result } = await roundTrip(login, 'Jane.Doe@Example.com', 'webchat:tailscale:jane@example.com');
    expect(result).toMatchObject({ ok: true, linkFrom: 'webchat:tailscale:jane@example.com' });
  });

  it('parses only its own cookie, and only a well-formed token', async () => {
    const { signins } = await load();
    expect(signins.sessionTokenFromCookie('a=1; nanoclaw_session=abcdefghijklmnopqrstuvwxyz0123; b=2')).toBe(
      'abcdefghijklmnopqrstuvwxyz0123',
    );
    expect(signins.sessionTokenFromCookie('nanoclaw_session=../../etc')).toBeNull();
    expect(signins.sessionTokenFromCookie(undefined)).toBeNull();
  });
});

describe('Sign-in routes', () => {
  /** A response that records what the route did. */
  function fakeRes() {
    const out: { status?: number; headers: Record<string, unknown>; body?: string } = { headers: {} };
    const res = {
      setHeader: (k: string, v: unknown) => void (out.headers[k.toLowerCase()] = v),
      writeHead: (status: number, headers: Record<string, unknown> = {}) => {
        out.status = status;
        for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = v;
      },
      end: (b?: string) => void (out.body = b),
    };
    return { res: res as never, out };
  }
  const cookiesOf = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : v ? [String(v)] : []);

  async function start(routes: typeof import('./server/routes-signin.js')) {
    const { res, out } = fakeRes();
    await routes.handlePreAuthSignin(fakeReq(), res, new URL('http://central.example/auth/microsoft/login'), 'GET');
    const to = new URL(String(out.headers.location));
    const stateCookie = cookiesOf(out.headers['set-cookie']).find((c) => c.startsWith('nanoclaw_signin_state='))!;
    return { to, state: to.searchParams.get('state')!, nonce: to.searchParams.get('nonce')!, stateCookie };
  }

  it('binds the attempt to the browser that started it: a callback link replayed elsewhere is refused', async () => {
    await load();
    const routes = await import('./server/routes-signin.js');
    const { state, nonce, stateCookie } = await start(routes);
    expect(stateCookie).toContain(`=${state}`);
    expect(stateCookie).toMatch(/HttpOnly/);
    nextIdToken = () => mintIdToken(idClaims(nonce));
    const cb = new URL(`http://central.example/auth/microsoft/callback?code=c&state=${state}`);

    // Another browser (no state cookie) following the same link: refused, nothing redeemed.
    const other = fakeRes();
    await routes.handlePreAuthSignin(fakeReq(), other.res, cb, 'GET');
    expect(String(other.out.headers.location)).toContain('signin_error=');
    expect(cookiesOf(other.out.headers['set-cookie']).some((c) => c.startsWith('nanoclaw_session='))).toBe(false);
    expect(lastTokenBody).toBeNull();

    // The browser that started it: signed in.
    const mine = fakeRes();
    const cookie = stateCookie.split(';')[0];
    await routes.handlePreAuthSignin(fakeReq({ headers: { cookie } }), mine.res, cb, 'GET');
    expect(String(mine.out.headers.location)).toBe('/?signin=signed-in');
    const set = cookiesOf(mine.out.headers['set-cookie']);
    expect(set.some((c) => /^nanoclaw_session=[\w-]{20,}/.test(c))).toBe(true);
    expect(set.some((c) => c.startsWith('nanoclaw_signin_state=;'))).toBe(true); // cleared
  });

  it('sign-out needs the CSRF header, ends the session and clears the cookie', async () => {
    const { signins, auth } = await load();
    const routes = await import('./server/routes-signin.js');
    const token = await signins.createSigninSession('webchat:jane.doe@example.com', 'Jane Doe');
    const cookie = `nanoclaw_session=${token}`;
    const refused = fakeRes();
    await routes.handlePreAuthSignin(
      fakeReq({ headers: { cookie } }),
      refused.res,
      new URL('http://central.example/auth/logout'),
      'POST',
    );
    expect(refused.out.status).toBe(403);
    const ok = fakeRes();
    await routes.handlePreAuthSignin(
      fakeReq({ headers: { cookie, 'x-webchat-csrf': '1' } }),
      ok.res,
      new URL('http://central.example/auth/logout'),
      'POST',
    );
    expect(ok.out.status).toBe(200);
    expect(String(ok.out.headers['set-cookie'])).toMatch(/^nanoclaw_session=;.*Max-Age=0/);
    expect((await auth.authenticateRequest(fakeReq({ headers: { cookie } }))).ok).toBe(false);
  });
});

describe('Sign in with another OIDC provider', () => {
  const O_ISS = 'https://sso.example.org/realms/main';
  const O_JWKS = `${O_ISS}/certs`;
  const O_TOKEN = `${O_ISS}/token`;
  const OTHER = {
    ...ENTRA,
    WEBCHAT_OIDC_PROVIDER: 'other',
    WEBCHAT_OIDC_NAME: 'Keycloak',
    WEBCHAT_OIDC_ISSUER: O_ISS,
    WEBCHAT_OIDC_AUDIENCE: 'nanoclaw',
    WEBCHAT_OIDC_JWKS_URI: O_JWKS,
    WEBCHAT_OIDC_AUTHORIZE_URL: `${O_ISS}/auth?kc_idp_hint=corp`,
    WEBCHAT_OIDC_TOKEN_URL: O_TOKEN,
  };
  let lastHeaders: Record<string, string> = {};

  beforeEach(() => {
    lastHeaders = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url) === O_JWKS) return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
        if (String(url) === O_TOKEN) {
          lastTokenBody = new URLSearchParams(String(init?.body ?? ''));
          lastHeaders = (init?.headers ?? {}) as Record<string, string>;
          return { ok: true, status: 200, json: async () => ({ id_token: nextIdToken(lastTokenBody!) }) };
        }
        throw new Error(`unexpected fetch: ${String(url)}`);
      }),
    );
  });

  const claimsFor = (nonce: string) => ({
    iss: O_ISS,
    aud: 'nanoclaw',
    exp: nowS() + 3600,
    nonce,
    email: 'Sam@Example.org',
    email_verified: true,
    name: 'Sam',
  });

  it("sends the browser to the provider's own authorize endpoint, keeping its query; prompt=login when linking", async () => {
    const { login } = await load(OTHER);
    const to = new URL(login.beginLogin({ redirectUri: 'https://central.example/auth/oidc/callback', linkFrom: 'x' }));
    expect(`${to.origin}${to.pathname}`).toBe(`${O_ISS}/auth`);
    expect(to.searchParams.get('kc_idp_hint')).toBe('corp');
    expect(to.searchParams.get('client_id')).toBe('nanoclaw');
    expect(to.searchParams.get('prompt')).toBe('login');
  });

  it('redeems at its token endpoint; the secret goes as HTTP Basic when the provider wants that', async () => {
    const { login } = await load({ ...OTHER, WEBCHAT_OIDC_CLIENT_SECRET: 's3cr:et', WEBCHAT_OIDC_TOKEN_AUTH: 'basic' });
    const to = new URL(login.beginLogin({ redirectUri: 'https://central.example/auth/oidc/callback' }));
    nextIdToken = () => mintIdToken(claimsFor(to.searchParams.get('nonce')!));
    const r = await login.completeLogin(new URLSearchParams({ code: 'c', state: to.searchParams.get('state')! }));
    expect(r).toMatchObject({ ok: true, identity: { identity: 'Sam@Example.org' } });
    expect(lastTokenBody!.get('client_secret')).toBeNull();
    expect(lastHeaders.Authorization).toBe(`Basic ${Buffer.from('nanoclaw:s3cr%3Aet').toString('base64')}`);
  });

  it('the login route answers on /auth/oidc/login, with the state cookie covering both callback paths', async () => {
    await load(OTHER);
    const routes = await import('./server/routes-signin.js');
    const out: { headers: Record<string, unknown> } = { headers: {} };
    const res = {
      writeHead: (_s: number, h: Record<string, unknown> = {}) => {
        for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v;
      },
      end: () => {},
    };
    await routes.handlePreAuthSignin(fakeReq(), res as never, new URL('http://central.example/auth/oidc/login'), 'GET');
    const to = new URL(String(out.headers.location));
    expect(to.searchParams.get('redirect_uri')).toBe('http://central.example/auth/oidc/callback');
    expect(String(out.headers['set-cookie'])).toContain('Path=/auth/');
  });
});
