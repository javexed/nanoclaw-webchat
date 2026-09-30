import { describe, expect, it } from 'vitest';

import {
  derivedClientConfig,
  effectiveClientConfig,
  mergeOverrides,
  parseOverrides,
  readStoredOverrides,
} from './runner-client-config.js';

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
    // An https audience can name Microsoft's own APIs; central never hands one to an editor.
    expect(parseOverrides({ appIdUri: 'https://management.azure.com' })).toMatchObject({ ok: false });
  });
});

describe('readStoredOverrides', () => {
  it('keeps the stored fields that still validate and names the ones dropped', () => {
    expect(readStoredOverrides(JSON.stringify({ clientId: CID, appIdUri: 'https://management.azure.com' }))).toEqual({
      overrides: { clientId: CID },
      dropped: [expect.stringContaining('appIdUri')],
    });
    expect(readStoredOverrides(JSON.stringify({ signIn: 'microsoft', tenantId: TID, clientId: CID }))).toEqual({
      overrides: { clientId: CID },
      dropped: [],
    });
    expect(readStoredOverrides('{not json')).toMatchObject({ overrides: {}, dropped: [expect.any(String)] });
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

describe('the release signing key', () => {
  const KEY = `ed25519:${Buffer.alloc(32, 5).toString('base64')}`;
  it('is taken only as an Ed25519 public key', () => {
    expect(parseOverrides({ releaseKey: ` ${KEY} ` })).toEqual({ ok: true, overrides: { releaseKey: KEY } });
    expect(parseOverrides({ releaseKey: 'ssh-ed25519 AAAA' })).toMatchObject({ ok: false });
  });
  it('is kept when a change does not name it, and cleared by an empty one', () => {
    const current = { clientId: CID, releaseKey: KEY };
    const signin = { appIdUri: `api://${CID}`, clientId: '' };
    expect(mergeOverrides(current, signin, { appIdUri: `api://${CID}` })).toEqual({
      appIdUri: `api://${CID}`,
      releaseKey: KEY,
    });
    expect(mergeOverrides(current, { releaseKey: '' }, {})).toEqual({ clientId: CID });
  });
  it('is offered whatever the sign-in', () => {
    const network = { signIn: 'network' as const, tenantId: '', appIdUri: '', clientId: '' };
    expect(effectiveClientConfig({ clientId: CID, releaseKey: KEY }, network)).toEqual({ ...network, releaseKey: KEY });
  });
});
