import { describe, expect, it } from 'vitest';

import { DEFAULT_TAG, edgeBridgeName, tailnetSettings } from './config.js';

const settings = (env: Record<string, string>) => tailnetSettings((k) => env[k]);
const on = { NANOCLAW_WORKLOAD_TAILNET: '1', NANOCLAW_WORKLOAD_TAILNET_DOMAIN: 'tail1234.ts.net' };

describe('tailnet settings', () => {
  it('is off unless switched on', () => {
    expect(settings({})).toEqual({ on: false });
    expect(settings({ NANOCLAW_WORKLOAD_TAILNET: 'yes' })).toEqual({ on: false });
  });

  it('defaults the tag, edge subnet and pinned image', () => {
    const s = settings(on);
    expect(s).toMatchObject({ on: true, ok: true });
    if (!s.on || !s.ok) throw new Error('unreachable');
    expect(s.cfg).toMatchObject({
      domain: 'tail1234.ts.net',
      tag: DEFAULT_TAG,
      subnet: '198.51.100.0/24',
      gateway: '198.51.100.1',
      prefix: '198.51.100',
    });
    expect(s.cfg.image).toMatch(/^tailscale\/tailscale:[^@]+@sha256:[a-f0-9]{64}$/);
  });

  it('needs the tailnet’s DNS name', () => {
    expect(settings({ NANOCLAW_WORKLOAD_TAILNET: '1' })).toMatchObject({ ok: false, reason: /DOMAIN is not set/ });
    expect(settings({ ...on, NANOCLAW_WORKLOAD_TAILNET_DOMAIN: 'example.com' })).toMatchObject({ ok: false });
    expect(settings({ ...on, NANOCLAW_WORKLOAD_TAILNET_DOMAIN: 'Tail1234.TS.net.' })).toMatchObject({ ok: true });
  });

  it('refuses an edge subnet in the workload, loopback or tailnet ranges', () => {
    for (const subnet of ['198.18.5.0/24', '127.1.0.0/24', '100.96.1.0/24', '10.0.0.0/16', '300.1.1.0/24'])
      expect(settings({ ...on, NANOCLAW_WORKLOAD_TAILNET_SUBNET: subnet })).toMatchObject({ ok: false });
    expect(settings({ ...on, NANOCLAW_WORKLOAD_TAILNET_SUBNET: '10.0.5.0/24' })).toMatchObject({ ok: true });
  });

  it('takes an image override only by digest, and one tag', () => {
    expect(settings({ ...on, NANOCLAW_WORKLOAD_TAILNET_IMAGE: 'tailscale/tailscale:latest' })).toMatchObject({
      ok: false,
    });
    expect(settings({ ...on, NANOCLAW_WORKLOAD_TAILNET_TAG: 'tag:a,tag:b' })).toMatchObject({ ok: false });
  });

  it('names a bridge the host rules match (nct…, at most 15 characters)', () => {
    expect(edgeBridgeName()).toMatch(/^nct[0-9a-f]{6}$/);
  });
});
