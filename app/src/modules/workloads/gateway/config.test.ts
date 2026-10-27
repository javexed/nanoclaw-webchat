import { describe, expect, it } from 'vitest';

import { gatewaySettings, wildcardAddress } from './config.js';

const settings = (s: Record<string, string>, env: Record<string, string> = {}) =>
  gatewaySettings((k) => s[k], env as NodeJS.ProcessEnv);

describe('workload gateway settings', () => {
  it('is off unless a port is set', () => {
    expect(settings({})).toEqual({ on: false });
  });

  it('listens on loopback by default, with the check on the next port and a digest-pinned image', () => {
    const s = settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: '8470' });
    expect(s).toMatchObject({ on: true, ok: true, cfg: { bind: '127.0.0.1', port: 8470, internalPort: 8471 } });
    expect((s as { cfg: { image: string } }).cfg.image).toMatch(/^caddy:[^@]+@sha256:[a-f0-9]{64}$/);
  });

  it('refuses every-interface binds', () => {
    for (const bind of ['0.0.0.0', '::', '[::]', '*']) {
      const s = settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: '8470', NANOCLAW_WORKLOAD_GATEWAY_BIND: bind });
      expect(s, bind).toMatchObject({ on: true, ok: false, reason: expect.stringMatching(/not every interface/) });
    }
    expect(wildcardAddress('192.0.2.7')).toBe(false);
  });

  it('takes one explicit address, IPv4 or IPv6, and nothing that is not an address', () => {
    expect(
      settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: '8470', NANOCLAW_WORKLOAD_GATEWAY_BIND: '192.0.2.7' }),
    ).toMatchObject({
      ok: true,
      cfg: { bind: '192.0.2.7' },
    });
    expect(
      settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: '8470', NANOCLAW_WORKLOAD_GATEWAY_BIND: '[2001:db8::1]' }),
    ).toMatchObject({
      ok: true,
      cfg: { bind: '2001:db8::1' },
    });
    expect(
      settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: '8470', NANOCLAW_WORKLOAD_GATEWAY_BIND: 'gw.evil.example' }),
    ).toMatchObject({ ok: false });
  });

  it('will not run while webchat trusts proxy headers from any address', () => {
    for (const trust of ['auto', '*']) {
      expect(settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: '8470' }, { WEBCHAT_TRUSTED_PROXY_IPS: trust })).toMatchObject({
        on: true,
        ok: false,
        reason: expect.stringMatching(/WEBCHAT_TRUSTED_PROXY_IPS/),
      });
    }
    expect(
      settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: '8470' }, { WEBCHAT_TRUSTED_PROXY_IPS: '10.0.0.5' }),
    ).toMatchObject({
      ok: true,
    });
  });

  it('refuses bad ports and an image without a digest', () => {
    expect(settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: 'http' })).toMatchObject({ ok: false });
    expect(
      settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: '8470', NANOCLAW_WORKLOAD_GATEWAY_INTERNAL_PORT: '8470' }),
    ).toMatchObject({ ok: false });
    expect(
      settings({ NANOCLAW_WORKLOAD_GATEWAY_PORT: '8470', NANOCLAW_WORKLOAD_GATEWAY_IMAGE: 'caddy:latest' }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/digest/) });
  });
});
