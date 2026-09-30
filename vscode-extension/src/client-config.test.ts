import { describe, expect, it } from 'vitest';

import { parseConnectQuery, resolveClientConfig, sanitizeClientConfig, signInChanges } from './client-config.js';

const TID = '11111111-2222-3333-4444-555555555555';
const CID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('connect link', () => {
  it('takes the server and the sign-in settings it carries', () => {
    const q = new URLSearchParams({
      server: 'https://chat.example.com/',
      signIn: 'microsoft',
      tenantId: TID,
      appIdUri: `api://${CID}`,
      clientId: CID,
    });
    expect(parseConnectQuery(q.toString())).toEqual({
      serverUrl: 'https://chat.example.com',
      config: { signIn: 'microsoft', tenantId: TID, appIdUri: `api://${CID}`, clientId: CID },
    });
  });

  it('carries an offered release signing key, and only a well-formed one', () => {
    const key = `ed25519:${Buffer.alloc(32, 1).toString('base64')}`;
    const q = (k: string) => `server=https://chat.example.com&releaseKey=${encodeURIComponent(k)}`;
    expect(parseConnectQuery(q(key))).toMatchObject({ releaseKey: key });
    expect(parseConnectQuery(q('ed25519:nope'))).not.toHaveProperty('releaseKey');
  });

  it('refuses a plain-http server, except loopback', () => {
    expect(parseConnectQuery('server=http://chat.example.com')).toEqual({ error: expect.stringContaining('https') });
    expect(parseConnectQuery('server=http://localhost:3100')).toMatchObject({ serverUrl: 'http://localhost:3100' });
  });

  it('refuses a link with no server', () => {
    expect(parseConnectQuery(`tenantId=${TID}`)).toEqual({ error: expect.any(String) });
  });

  it('keeps only the origin: a path, query or fragment would reach the same central under another name', () => {
    expect(parseConnectQuery('server=' + encodeURIComponent('https://c.example.com/x?y=1#z'))).toMatchObject({
      serverUrl: 'https://c.example.com',
    });
  });
});

describe('sanitizeClientConfig', () => {
  it('keeps only well-formed values', () => {
    expect(
      sanitizeClientConfig({
        signIn: 'password',
        tenantId: 'not-a-guid',
        appIdUri: 'javascript:alert(1)',
        clientId: CID,
        extra: 'x',
      }),
    ).toEqual({ clientId: CID });
    expect(sanitizeClientConfig(null)).toEqual({});
  });

  it("takes only an app's own api:// audience from a link or a server, never an https one", () => {
    expect(sanitizeClientConfig({ appIdUri: 'https://management.azure.com' })).toEqual({});
    expect(sanitizeClientConfig({ appIdUri: `api://${CID}` })).toEqual({ appIdUri: `api://${CID}` });
  });
});

describe('signInChanges', () => {
  it('names what central changed from what was remembered, and nothing on a first answer', () => {
    expect(signInChanges(null, { appIdUri: 'api://a' })).toEqual([]);
    expect(signInChanges({ appIdUri: 'api://a', tenantId: TID }, { appIdUri: 'api://b', tenantId: TID })).toEqual([
      'appIdUri',
    ]);
    expect(signInChanges({ appIdUri: 'api://a' }, { appIdUri: 'api://a' })).toEqual([]);
  });
});

describe('resolveClientConfig', () => {
  it("the user's own setting wins, then central's, then the default", () => {
    expect(
      resolveClientConfig({ tenantId: TID }, { tenantId: 'other', appIdUri: 'api://x', signIn: 'network' }),
    ).toEqual({
      signIn: 'network',
      tenantId: TID,
      appIdUri: 'api://x',
      clientId: '',
    });
    expect(resolveClientConfig({}, {})).toEqual({ signIn: 'microsoft', tenantId: '', appIdUri: '', clientId: '' });
  });
});
