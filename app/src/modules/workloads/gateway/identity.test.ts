import { describe, expect, it, vi } from 'vitest';

import { cloudflareIdentity, decodeServeHeader, tailnetIdentity, type JwtVerifier } from './identity.js';
import type { PublishedApp } from './publishing.js';

const app: PublishedApp = { id: 'r1', app: 'notes', hostname: 'notes.tail1.ts.net', agentGroupId: 'ag-1' };
const other: PublishedApp = { ...app, id: 'r2', app: 'wiki', hostname: 'wiki.tail1.ts.net' };

describe('tailnet identity', () => {
  const identify = tailnetIdentity({
    trustedPeers: async (a) => (a.id === 'r1' ? ['198.18.0.200'] : ['198.18.0.201']),
  });

  it('believes Tailscale-User-Login from the app’s own sidecar', async () => {
    const who = await identify(
      {
        headers: { 'tailscale-user-login': 'Alice@Example.com', 'tailscale-user-name': 'Alice A' },
        peer: '198.18.0.200',
      },
      app,
    );
    expect(who).toEqual({ userId: 'webchat:tailscale:alice@example.com', displayName: 'Alice A' });
  });

  it('reads the RFC 2047 names serve sends for non-ASCII', async () => {
    expect(decodeServeHeader('=?utf-8?q?J=C3=B6rg_M=C3=BCller?=')).toBe('Jörg Müller');
    expect(decodeServeHeader('=?utf-8?q?J=C3=B6rg?= =?utf-8?q?_M=C3=BCller?=')).toBe('Jörg Müller');
    expect(decodeServeHeader('plain@example.com')).toBe('plain@example.com');
    expect(decodeServeHeader('=?utf-8?q?=FF?=')).toBe('');
    const who = await identify(
      {
        headers: { 'tailscale-user-login': 'j@example.com', 'tailscale-user-name': '=?utf-8?q?J=C3=B6rg?=' },
        peer: '198.18.0.200',
      },
      app,
    );
    expect(who?.displayName).toBe('Jörg');
  });

  it('ignores it from any other peer, including another app’s sidecar', async () => {
    const headers = { 'tailscale-user-login': 'owner@example.com' };
    expect(await identify({ headers, peer: '127.0.0.1' }, app)).toBeNull();
    expect(await identify({ headers, peer: '198.18.0.201' }, app)).toBeNull();
    expect(await identify({ headers, peer: '198.18.0.200' }, other)).toBeNull();
    expect(await identify({ headers, peer: '' }, app)).toBeNull();
  });

  it('refuses a missing, repeated or odd login (a tagged device sends none)', async () => {
    const peer = '::ffff:198.18.0.200';
    expect(await identify({ headers: {}, peer }, app)).toBeNull();
    expect(
      await identify({ headers: { 'tailscale-user-login': ['a@x.example', 'b@x.example'] }, peer }, app),
    ).toBeNull();
    expect(await identify({ headers: { 'tailscale-user-login': 'a@x.example, b@x.example' }, peer }, app)).toBeNull();
    expect(await identify({ headers: { 'tailscale-user-login': 'a@x.example' }, peer }, app)).toMatchObject({
      displayName: 'a@x.example',
    });
  });
});

describe('Cloudflare Access identity', () => {
  const verify = vi.fn<JwtVerifier>(async (token, cfg) =>
    token === 'good' && cfg.audience === 'aud-notes'
      ? { ok: true, claims: { email: 'Alice@Example.com', name: 'Alice A' } }
      : token === 'service' && cfg.audience === 'aud-notes'
        ? { ok: true, claims: { common_name: 'svc' } }
        : { ok: false, reason: 'audience' },
  );
  const identify = cloudflareIdentity({
    trustedPeers: async () => ['198.51.100.239'],
    teamDomain: () => 'https://team.cloudflareaccess.com/',
    audienceFor: async (a) => (a.id === 'r1' ? 'aud-notes' : a.id === 'r2' ? 'aud-wiki' : null),
    verify,
  });

  it('verifies the assertion for THIS app’s Access audience', async () => {
    const who = await identify({ headers: { 'cf-access-jwt-assertion': 'good' }, peer: '198.51.100.239' }, app);
    expect(who).toEqual({ userId: 'webchat:alice@example.com', displayName: 'Alice A' });
    expect(verify).toHaveBeenLastCalledWith('good', {
      issuer: 'https://team.cloudflareaccess.com',
      audience: 'aud-notes',
      jwksUri: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    });
  });

  it('refuses a token Access issued for another app', async () => {
    expect(
      await identify({ headers: { 'cf-access-jwt-assertion': 'good' }, peer: '198.51.100.239' }, other),
    ).toBeNull();
  });

  it('refuses no token, a service token, an app without an audience, and the bare email header', async () => {
    expect(
      await identify(
        { headers: { 'cf-access-authenticated-user-email': 'owner@x.example' }, peer: '198.51.100.239' },
        app,
      ),
    ).toBeNull();
    expect(
      await identify({ headers: { 'cf-access-jwt-assertion': 'service' }, peer: '198.51.100.239' }, app),
    ).toBeNull();
    expect(
      await identify({ headers: { 'cf-access-jwt-assertion': 'good' }, peer: '198.51.100.239' }, { ...app, id: 'r3' }),
    ).toBeNull();
  });

  it('believes nothing that does not come from the connector', async () => {
    for (const peer of ['127.0.0.1', '198.51.100.2', '198.51.100.1', ''])
      expect(await identify({ headers: { 'cf-access-jwt-assertion': 'good' }, peer }, app)).toBeNull();
    expect(
      await identify({ headers: { 'cf-access-jwt-assertion': 'good' }, peer: '::ffff:198.51.100.239' }, app),
    ).not.toBeNull();
  });

  it('is off until the team domain is set', async () => {
    const off = cloudflareIdentity({
      trustedPeers: async () => ['198.51.100.239'],
      teamDomain: () => '',
      audienceFor: async () => 'aud-notes',
      verify,
    });
    expect(await off({ headers: { 'cf-access-jwt-assertion': 'good' }, peer: '198.51.100.239' }, app)).toBeNull();
  });
});
