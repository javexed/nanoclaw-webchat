import { describe, expect, it } from 'vitest';

import { derivedClientConfig, effectiveClientConfig, parseOverrides } from './runner-client-config.js';

const TID = '11111111-2222-3333-4444-555555555555';
const CID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('derivedClientConfig', () => {
  it('reads the tenant from the issuer and the app id URI from the audience', () => {
    expect(
      derivedClientConfig({
        WEBCHAT_OIDC_ISSUER: `https://login.microsoftonline.com/${TID}/v2.0`,
        WEBCHAT_OIDC_AUDIENCE: CID,
      }),
    ).toEqual({ signIn: 'microsoft', tenantId: TID, appIdUri: `api://${CID}`, clientId: '' });
  });

  it('keeps an audience that is already a URI', () => {
    expect(
      derivedClientConfig({
        WEBCHAT_OIDC_ISSUER: `https://login.microsoftonline.com/${TID}/v2.0`,
        WEBCHAT_OIDC_AUDIENCE: 'api://nanoclaw-prod',
      }).appIdUri,
    ).toBe('api://nanoclaw-prod');
  });

  it('means network sign-in when the install has no OIDC', () => {
    expect(derivedClientConfig({})).toEqual({ signIn: 'network', tenantId: '', appIdUri: '', clientId: '' });
  });
});

describe('derivedClientConfig — another provider', () => {
  it('signs the extension in over the network: VS Code signs in only with Microsoft', () => {
    expect(
      derivedClientConfig({
        WEBCHAT_OIDC_PROVIDER: 'other',
        WEBCHAT_OIDC_ISSUER: 'https://sso.example.org',
        WEBCHAT_OIDC_AUDIENCE: 'nanoclaw',
        WEBCHAT_OIDC_JWKS_URI: 'https://sso.example.org/keys',
      }),
    ).toEqual({ signIn: 'network', tenantId: '', appIdUri: '', clientId: '' });
  });
});

describe('parseOverrides', () => {
  it('takes the App ID URI and the extension client id; empty clears; the rest follows Admin → Sign-in', () => {
    expect(parseOverrides({ tenantId: TID, clientId: '', appIdUri: ` api://${CID} `, signIn: 'network' })).toEqual({
      ok: true,
      overrides: { appIdUri: `api://${CID}` },
    });
  });

  it('refuses malformed values rather than dropping them', () => {
    expect(parseOverrides({ clientId: 'contoso' })).toEqual({ ok: false, error: 'clientId must be a GUID' });
    expect(parseOverrides({ appIdUri: 'javascript:alert(1)' })).toMatchObject({ ok: false });
  });
});

describe('effectiveClientConfig', () => {
  it('an override wins over the derived value, per key — only when signing in with Microsoft', () => {
    const derived = { signIn: 'microsoft' as const, tenantId: TID, appIdUri: `api://${CID}`, clientId: '' };
    expect(effectiveClientConfig({ clientId: CID }, derived)).toEqual({ ...derived, clientId: CID });
    expect(effectiveClientConfig({}, derived)).toEqual(derived);
    const network = { signIn: 'network' as const, tenantId: '', appIdUri: '', clientId: '' };
    expect(effectiveClientConfig({ clientId: CID }, network)).toEqual(network);
  });
});
