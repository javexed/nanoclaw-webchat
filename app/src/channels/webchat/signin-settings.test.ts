import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyOidc,
  applyProxy,
  applyTailscale,
  clearOidc,
  clearProxy,
  discover,
  readOidc,
  readProxy,
  validateOidcInput,
  validateProxyInput,
} from './signin-settings.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MS_ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const ISS = 'https://sso.example.org/realms/main';

const answer = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as unknown as Response);

const otherDoc = (extra: Record<string, unknown> = {}) => ({
  issuer: ISS,
  jwks_uri: `${ISS}/certs`,
  authorization_endpoint: `${ISS}/auth`,
  token_endpoint: `${ISS}/token`,
  id_token_signing_alg_values_supported: ['RS256'],
  ...extra,
});

describe('trusted proxy input', () => {
  it('takes IPv4 addresses and CIDRs, space or comma separated, and a header name', () => {
    expect(validateProxyInput({ ips: '10.0.0.5, 198.51.100.0/24  203.0.113.9', header: 'X-Auth-User' })).toEqual({
      ok: true,
      ips: '10.0.0.5,198.51.100.0/24,203.0.113.9',
      header: 'x-auth-user',
    });
    expect(validateProxyInput({ ips: '10.0.0.5' })).toMatchObject({ ok: true, header: 'x-forwarded-user' });
  });

  it('refuses auto / * (trust anyone), and anything that is not an address', () => {
    for (const ips of [
      'auto',
      '*',
      '10.0.0.5, auto',
      '',
      'proxy.local',
      '10.0.0.256',
      '10.0.0.0/33',
      '::1',
      '1.2.3.4/8/9',
    ])
      expect(validateProxyInput({ ips }).ok, ips).toBe(false);
    expect(validateProxyInput({ ips: '10.0.0.5', header: 'x auth' }).ok).toBe(false);
  });
});

describe('OIDC input', () => {
  it('Microsoft: a tenant GUID or domain and the app client id', () => {
    expect(
      validateOidcInput({ provider: 'microsoft', tenant: 'Contoso.onmicrosoft.com', clientId: CLIENT }),
    ).toMatchObject({ ok: true, provider: 'microsoft', where: 'contoso.onmicrosoft.com', clientId: CLIENT });
    expect(validateOidcInput({ provider: 'microsoft', tenant: 'common', clientId: CLIENT }).ok).toBe(false);
    expect(validateOidcInput({ provider: 'microsoft', tenant: TENANT, clientId: 'nanoclaw' }).ok).toBe(false);
  });

  it('Other: an https issuer, any client id, an optional name', () => {
    expect(validateOidcInput({ provider: 'other', issuer: ISS, clientId: 'nanoclaw', name: 'Keycloak' })).toMatchObject(
      {
        ok: true,
        where: ISS,
        name: 'Keycloak',
      },
    );
    for (const issuer of [
      'http://sso.example.org',
      'https://u:p@sso.example.org',
      'https://sso.example.org/?x=1',
      'sso',
    ])
      expect(validateOidcInput({ provider: 'other', issuer, clientId: 'x' }).ok, issuer).toBe(false);
    expect(validateOidcInput({ provider: 'other', issuer: ISS, clientId: 'a b' }).ok).toBe(false);
    expect(validateOidcInput({ provider: 'other', issuer: ISS, clientId: 'x', name: '<b>' }).ok).toBe(false);
    expect(validateOidcInput({ provider: 'okta', issuer: ISS, clientId: 'x' }).ok).toBe(false);
  });

  it('refuses a secret with a line break (it goes into .env)', () => {
    expect(
      validateOidcInput({ provider: 'other', issuer: ISS, clientId: 'x', clientSecret: 'a\nWEBCHAT_HOST=0.0.0.0' }).ok,
    ).toBe(false);
  });
});

describe('discovery', () => {
  it("Microsoft: the tenant's own configuration; a domain resolves to the GUID issuer", async () => {
    const f = answer(200, {
      issuer: MS_ISSUER,
      jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
      authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
      token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    });
    const r = await discover({ provider: 'microsoft', where: 'contoso.onmicrosoft.com' }, f);
    expect(r).toMatchObject({ ok: true, issuer: MS_ISSUER, tokenAuthBasic: false });
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0/.well-known/openid-configuration',
    );
  });

  it('Microsoft: refuses a multi-tenant issuer and keys off its authority', async () => {
    const base = {
      jwks_uri: 'https://login.microsoftonline.com/x/keys',
      authorization_endpoint: 'https://a',
      token_endpoint: 'https://t',
    };
    expect(
      (
        await discover(
          { provider: 'microsoft', where: TENANT },
          answer(200, { ...base, issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' }),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await discover(
          { provider: 'microsoft', where: TENANT },
          answer(200, { ...base, issuer: MS_ISSUER, jwks_uri: 'https://evil.example/keys' }),
        )
      ).ok,
    ).toBe(false);
  });

  it('Other: <issuer>/.well-known/openid-configuration, whose issuer must be the one asked for', async () => {
    const f = answer(200, otherDoc());
    expect(await discover({ provider: 'other', where: ISS }, f)).toMatchObject({
      ok: true,
      issuer: ISS,
      jwksUri: `${ISS}/certs`,
      authorizeUrl: `${ISS}/auth`,
      tokenUrl: `${ISS}/token`,
    });
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(`${ISS}/.well-known/openid-configuration`);
    // A trailing slash typed by the admin still finds the same document and issuer.
    expect((await discover({ provider: 'other', where: `${ISS}/` }, answer(200, otherDoc()))).ok).toBe(true);
    expect(
      (await discover({ provider: 'other', where: ISS }, answer(200, otherDoc({ issuer: 'https://evil.example' })))).ok,
    ).toBe(false);
  });

  it('Other: refuses http endpoints, unsupported algorithms, and a missing document', async () => {
    expect(
      (
        await discover(
          { provider: 'other', where: ISS },
          answer(200, otherDoc({ token_endpoint: 'http://sso.example.org/token' })),
        )
      ).ok,
    ).toBe(false);
    expect((await discover({ provider: 'other', where: ISS }, answer(200, otherDoc({ jwks_uri: '' })))).ok).toBe(false);
    expect(
      (
        await discover(
          { provider: 'other', where: ISS },
          answer(200, otherDoc({ id_token_signing_alg_values_supported: ['HS256'] })),
        )
      ).ok,
    ).toBe(false);
    expect((await discover({ provider: 'other', where: ISS }, answer(404, {}))).ok).toBe(false);
  });

  it('Other: a provider that takes the secret only as HTTP Basic gets it that way', async () => {
    const r = await discover(
      { provider: 'other', where: ISS },
      answer(200, otherDoc({ token_endpoint_auth_methods_supported: ['client_secret_basic'] })),
    );
    expect(r.ok && r.tokenAuthBasic).toBe(true);
    const both = await discover(
      { provider: 'other', where: ISS },
      answer(200, otherDoc({ token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] })),
    );
    expect(both.ok && both.tokenAuthBasic).toBe(false);
  });
});

describe('applying', () => {
  let root = '';
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  const envFile = () => fs.readFileSync(path.join(root, '.env'), 'utf8');

  it('writes .env and the live environment together; the secret is write-only; clearing removes every key', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-'));
    fs.writeFileSync(path.join(root, '.env'), 'WEBCHAT_PORT=3101\nWEBCHAT_OIDC_LOGIN=false\n');
    const env: NodeJS.ProcessEnv = {};
    applyOidc(
      root,
      {
        provider: 'other',
        where: ISS,
        name: 'Keycloak',
        clientId: 'nanoclaw',
        secret: 's3cret-value',
        clearSecret: false,
        issuer: ISS,
        jwksUri: `${ISS}/certs`,
        authorizeUrl: `${ISS}/auth`,
        tokenUrl: `${ISS}/token`,
        tokenAuthBasic: true,
      },
      env,
    );
    expect(envFile()).toContain(`WEBCHAT_OIDC_ISSUER=${ISS}`);
    expect(envFile()).toContain('WEBCHAT_OIDC_TOKEN_AUTH=basic');
    // The old "show the button" switch goes: with OIDC on, the button is.
    expect(envFile()).not.toContain('WEBCHAT_OIDC_LOGIN');
    expect(env.WEBCHAT_OIDC_PROVIDER).toBe('other');
    const view = readOidc(env);
    expect(view).toEqual({
      enabled: true,
      provider: 'other',
      tenantId: '',
      issuer: ISS,
      name: 'Keycloak',
      clientId: 'nanoclaw',
      secretSet: true,
    });
    expect(JSON.stringify(view)).not.toContain('s3cret');
    clearOidc(root, env);
    expect(envFile()).toBe('WEBCHAT_PORT=3101\n');
    expect(readOidc(env).enabled).toBe(false);
  });

  it('Tailscale and the proxy, on and off; the default header is not written', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-'));
    fs.writeFileSync(path.join(root, '.env'), '');
    const env: NodeJS.ProcessEnv = {};
    applyTailscale(root, true, env);
    applyProxy(root, { ips: '10.0.0.5', header: 'x-forwarded-user' }, env);
    expect(envFile()).toContain('WEBCHAT_TAILSCALE=true');
    expect(envFile()).not.toContain('WEBCHAT_TRUSTED_PROXY_HEADER');
    expect(readProxy(env)).toEqual({ enabled: true, ips: '10.0.0.5', auto: false, header: 'x-forwarded-user' });
    applyTailscale(root, false, env);
    clearProxy(root, env);
    expect(envFile().trim()).toBe('');
    expect(readProxy({ WEBCHAT_TRUSTED_PROXY_IPS: 'auto' })).toMatchObject({ enabled: true, auto: true, ips: '' });
  });
});
