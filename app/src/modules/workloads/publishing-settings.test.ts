/**
 * Admin → Publishing's words and checks: status lines in a few words with the
 * full reason kept for a tooltip, and what the owner types refused per field.
 */
import { describe, expect, it } from 'vitest';

import { SettingRefused, shortReason, statusLine, validateCloudflare, validateTailnet } from './publishing-settings.js';

describe('status lines', () => {
  it('Connected, Off, Not connected, or the one thing missing in a few words', () => {
    expect(statusLine('tailnet', { state: 'connected', warnings: [] })).toMatchObject({ text: 'Connected', ok: true });
    expect(statusLine('tailnet', { state: 'off', warnings: [] }).text).toBe('Off');
    const vault = statusLine('tailnet', {
      state: 'missing',
      missing: 'the Tailscale OAuth client is not in the vault (Connect)',
      warnings: [],
    });
    expect(vault).toMatchObject({ text: 'Not connected', needsConnect: true });
    expect(vault.detail).toBe('The Tailscale OAuth client is not in the vault (Connect)');
  });

  it('never says vault or (Connect), and stays short', () => {
    const reasons = [
      'NANOCLAW_WORKLOAD_TAILNET_DOMAIN is not set (your tailnet’s DNS name, e.g. tail1234.ts.net)',
      'the host rules for the edge network are missing (sudo deploy/workloads-host-rules.sh --gateway 198.51.100.1:8470 --install-unit)',
      'the app gateway must listen on the edge address: set NANOCLAW_WORKLOAD_GATEWAY_BIND=198.51.100.1',
      'the app gateway is off (set NANOCLAW_WORKLOAD_GATEWAY_PORT)',
      'workloads are off on this host (NANOCLAW_WORKLOADS=1)',
      'the nanoclaw-cloudflare identity is missing in OneCLI (Connect again)',
      '2 OneCLI identities are in "all" secret mode and would be given the Cloudflare API token too: switch them to selective',
      'the app domain apps.example.com is the same site as NanoClaw’s own chat.example.com (both under example.com): use a different registrable domain',
      'HTTP 403 from api.cloudflare.com',
    ];
    const got = reasons.map((r) => shortReason('cloudflare', r));
    expect(got).toEqual([
      'Tailnet name missing',
      'Host rules missing',
      'App gateway bind address wrong',
      'App gateway off',
      'Workloads off',
      'Not connected',
      'OneCLI identities in all mode',
      'App domain is NanoClaw’s own site',
      'Cloudflare API not answering',
    ]);
    for (const t of got) {
      expect(t).not.toMatch(/vault|\(Connect\)/i);
      expect(t.split(' ').length).toBeLessThanOrEqual(6);
    }
  });

  it('warnings are short too, with the full text kept', () => {
    const s = statusLine('cloudflare', { state: 'connected', warnings: ['the tunnel is degraded'] });
    expect(s.warnings).toEqual([{ text: 'Tunnel not healthy', detail: 'The tunnel is degraded' }]);
  });
});

describe('what the owner types', () => {
  it('a tailnet name', () => {
    expect(validateTailnet({ on: true, domain: 'Tail1234.ts.net.' })).toEqual({ on: true, domain: 'tail1234.ts.net' });
    expect(() => validateTailnet({ domain: 'example.com' })).toThrow(SettingRefused);
    expect(() => validateTailnet({ on: 'yes' })).toThrow(SettingRefused);
  });

  it('a Cloudflare app domain on NanoClaw’s own site is refused under the field', () => {
    try {
      validateCloudflare({ domain: 'apps.example.com' }, ['chat.example.com']);
      throw new Error('not refused');
    } catch (err) {
      expect(err).toBeInstanceOf(SettingRefused);
      expect((err as SettingRefused).field).toBe('domain');
      expect((err as SettingRefused).message).toBe('Same site as NanoClaw (example.com)');
    }
    expect(validateCloudflare({ domain: 'example-apps.net' }, ['chat.example.com'])).toEqual({
      domain: 'example-apps.net',
    });
  });

  it('IDs and the team domain', () => {
    expect(validateCloudflare({ accountId: 'A'.repeat(32) }, [])).toEqual({ accountId: 'a'.repeat(32) });
    expect(() => validateCloudflare({ zoneId: 'xyz' }, [])).toThrow(/zone ID/);
    expect(validateCloudflare({ teamDomain: 'https://Team.cloudflareaccess.com/' }, [])).toEqual({
      teamDomain: 'team.cloudflareaccess.com',
    });
    expect(() => validateCloudflare({ teamDomain: 'team.example.com' }, [])).toThrow(SettingRefused);
  });
});
