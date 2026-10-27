import { describe, expect, it } from 'vitest';

import { cloudflareSettings } from './config.js';

const ON = {
  NANOCLAW_WORKLOAD_CLOUDFLARE: '1',
  NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN: 'example-apps.net',
  NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID: 'A'.repeat(32),
  NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID: 'b'.repeat(32),
  NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN: 'team.cloudflareaccess.com',
};
const settings = (vars: Record<string, string>, env: NodeJS.ProcessEnv = {}) => cloudflareSettings((k) => vars[k], env);

describe('Cloudflare settings', () => {
  it('is off unless switched on', () => {
    expect(settings({})).toEqual({ on: false });
    expect(settings({ NANOCLAW_WORKLOAD_CLOUDFLARE: 'yes' })).toEqual({ on: false });
  });

  it('reads the app domain, ids, team, the edge network and the pinned image', () => {
    const s = settings(ON);
    if (!s.on || !s.ok) throw new Error(JSON.stringify(s));
    expect(s.cfg).toMatchObject({
      domain: 'example-apps.net',
      accountId: 'a'.repeat(32),
      zoneId: 'b'.repeat(32),
      teamDomain: 'team.cloudflareaccess.com',
      gateway: '198.51.100.1',
      connector: '198.51.100.239',
    });
    expect(s.cfg.image).toMatch(/^cloudflare\/cloudflared:[^@]+@sha256:[a-f0-9]{64}$/);
    expect(s.cfg.tunnelName).toMatch(/^nanoclaw-/);
  });

  it('refuses an app domain that shares NanoClaw’s registrable domain', () => {
    for (const env of [
      { WEBCHAT_PUBLIC_URL: 'https://chat.example-apps.net' },
      { WEBCHAT_ALLOWED_HOSTS: 'localhost, nc.example-apps.net' },
    ])
      expect(settings(ON, env)).toMatchObject({ ok: false, reason: /same site as NanoClaw’s own/ });
    expect(
      settings(
        { ...ON, NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN: 'apps.example.com' },
        { WEBCHAT_PUBLIC_URL: 'https://example.com/' },
      ),
    ).toMatchObject({ ok: false });
    expect(settings(ON, { WEBCHAT_PUBLIC_URL: 'https://chat.example.com', WEBCHAT_ALLOWED_HOSTS: '*' })).toMatchObject({
      ok: true,
    });
  });

  it('refuses a public suffix, bad ids, a team domain that is not Access’s, an unpinned image', () => {
    expect(settings({ ...ON, NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN: 'co.uk' })).toMatchObject({ ok: false });
    expect(settings({ ...ON, NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID: 'x' })).toMatchObject({ ok: false });
    expect(settings({ ...ON, NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID: '' })).toMatchObject({ ok: false });
    expect(settings({ ...ON, NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN: 'team.example.com' })).toMatchObject({
      ok: false,
    });
    expect(settings({ ...ON, NANOCLAW_WORKLOAD_CLOUDFLARE_IMAGE: 'cloudflare/cloudflared:latest' })).toMatchObject({
      ok: false,
    });
  });

  it('takes the team domain from webchat’s own Cloudflare Access setting when not set', () => {
    const { NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN: _, ...rest } = ON;
    expect(settings(rest, { WEBCHAT_CF_ACCESS_TEAM_DOMAIN: 'https://other.cloudflareaccess.com/' })).toMatchObject({
      ok: true,
      cfg: { teamDomain: 'other.cloudflareaccess.com' },
    });
  });
});
