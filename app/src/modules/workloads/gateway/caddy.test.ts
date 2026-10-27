import { describe, expect, it } from 'vitest';

import { FORWARDED_HEADERS, renderCaddyfile, runArgs, validSite, validTarget } from './caddy.js';

const cfg = { bind: '127.0.0.1', port: 8470, internalPort: 8471, image: 'caddy@sha256:' + 'a'.repeat(64) };
const SECRET = 'S'.repeat(43);
const site = { id: '0b0f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e11', hostname: 'notes.tail1.ts.net', target: '198.18.0.10:8080' };

describe('gateway Caddyfile', () => {
  const text = renderCaddyfile(cfg, [site], SECRET);

  it('listens on the configured address only, admin on a Unix socket, no automatic HTTPS', () => {
    expect(text).toContain('\tdefault_bind 127.0.0.1\n');
    expect(text).toContain('\thttp_port 8470\n');
    expect(text).toContain('\tadmin unix//run/gw/admin.sock\n');
    expect(text).toContain('\tauto_https off\n');
    expect(text).not.toMatch(/0\.0\.0\.0|:2019/);
    expect(renderCaddyfile({ ...cfg, bind: '2001:db8::1' }, [], SECRET)).toContain('\tdefault_bind [2001:db8::1]\n');
  });

  it('checks every request with NanoClaw before proxying, and strips forged identity first', () => {
    const order = [
      'request_header -X-NanoClaw-*',
      'forward_auth 127.0.0.1:8471',
      'request_header -*',
      'reverse_proxy 198.18.0.10:8080',
    ];
    let at = 0;
    for (const step of order) {
      const i = text.indexOf(step, at);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
    expect(text).toContain(`header_up X-NanoClaw-Route ${site.id}`);
    expect(text).toContain('header_up X-NanoClaw-Peer {http.request.remote.host}');
    expect(text).toContain('copy_headers X-NanoClaw-User X-NanoClaw-Name X-NanoClaw-Auth X-NanoClaw-Identity');
  });

  it('forwards an allow-list of headers, never credentials from elsewhere', () => {
    const restored = [...text.matchAll(/request_header @nc_k\d+ (\S+) /g)].map((m) => m[1].toLowerCase());
    expect(restored).toEqual(FORWARDED_HEADERS.map((h) => h.toLowerCase()));
    for (const banned of [
      'authorization',
      'cf-access-jwt-assertion',
      'tailscale-user-login',
      'x-ms-client-principal-name',
      'x-forwarded-for',
      'forwarded',
      'x-forwarded-user',
      'proxy-authorization',
    ])
      expect(restored, banned).not.toContain(banned);
    expect(restored.filter((h) => h.startsWith('cf-') || h.startsWith('tailscale') || h.startsWith('x-ms-'))).toEqual(
      [],
    );
    // NanoClaw's and the edges' sign-in cookies go; the Host and X-Forwarded-* are set fresh.
    expect(text).toMatch(/request_header Cookie ".*nanoclaw_.*cf_authorization.*appserviceauthsession.*" ""/);
    expect(text).toContain('header_up Host notes.tail1.ts.net');
    expect(text).toContain('header_up X-Forwarded-Proto https');
    // An app sets cookies for its own host only.
    expect(text).toContain('header_down Set-Cookie "(?i);\\s*domain=[^;]*" ""');
  });

  it('answers 404 for any other host', () => {
    expect(text).toMatch(/http:\/\/ \{\n\trespond "Not found" 404\n\}/);
  });

  it('refuses to template anything unchecked', () => {
    const bad = [
      { ...site, hostname: 'notes.tail1.ts.net {\n\trespond hi' },
      { ...site, hostname: 'Notes.tail1.ts.net' },
      { ...site, target: '127.0.0.1:22' },
      { ...site, target: '198.18.0.10:8080 {' },
      { ...site, target: '10.0.0.1:80' },
      { ...site, id: 'r1 }' },
    ];
    for (const s of bad) expect(() => renderCaddyfile(cfg, [s], SECRET), JSON.stringify(s)).toThrow(/refusing/);
    expect(() => renderCaddyfile(cfg, [site, { ...site, id: '1b0f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e11' }], SECRET)).toThrow(
      /two gateway sites/,
    );
    expect(() => renderCaddyfile(cfg, [site], 'short')).toThrow(/secret/);
    expect(() => renderCaddyfile({ ...cfg, bind: '127.0.0.1 {' }, [site], SECRET)).toThrow(/bind/);
  });

  it('takes only workload-range targets', () => {
    expect(validTarget('198.18.0.10:8080')).toBe(true);
    expect(validTarget('198.19.255.127:1')).toBe(true);
    for (const t of [
      '198.18.0.0:80',
      '198.18.0.255:80',
      '198.20.0.1:80',
      '198.18.01.1:80',
      '198.18.0.1:0',
      '198.18.0.1:70000',
      '198.18.0.1',
    ])
      expect(validTarget(t), t).toBe(false);
    expect(validSite(site)).toBe(true);
  });
});

describe('gateway container', () => {
  it('runs read-only, unprivileged, with one capability, by digest', () => {
    const a = runArgs(cfg.image, '/srv/gw', 1000, 1000);
    expect(a).toEqual(
      expect.arrayContaining(['--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--user', '1000:1000']),
    );
    expect(a.filter((x) => x === '--cap-add')).toHaveLength(1);
    expect(a[a.indexOf('--cap-add') + 1]).toBe('NET_BIND_SERVICE');
    expect(a).toContain(cfg.image);
    expect(a).not.toContain('--privileged');
    expect(a.join(' ')).not.toMatch(/-p |--publish|nanoclaw-install=/);
  });
});
