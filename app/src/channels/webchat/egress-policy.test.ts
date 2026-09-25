import { describe, expect, it } from 'vitest';

import {
  BUILTIN_ALLOWLIST,
  defaultAllowlist,
  effectiveEgressMode,
  egressAllowed,
  hostMatches,
  isSafeEgressHost,
  modelHostPattern,
  modelPassthrough,
  parseAllowlist,
  parsePattern,
} from './egress-policy.js';

describe('runner egress patterns', () => {
  it('normalizes what an admin types and refuses what is not a host', () => {
    expect(parsePattern(' https://Registry.NPMJS.org/some/path ')).toEqual({ ok: true, pattern: 'registry.npmjs.org' });
    expect(parsePattern('*.pkgs.example.org')).toEqual({ ok: true, pattern: '*.pkgs.example.org' });
    expect(parsePattern('artifactory.example.org:8443')).toEqual({ ok: true, pattern: 'artifactory.example.org:8443' });
    for (const bad of ['', 'localhost', '*', '*.com.', 'a..b', 'foo.*.com', 'x.com:0', 'x.com:70000']) {
      expect(parsePattern(bad).ok, bad).toBe(false);
    }
    expect(parseAllowlist(['a.com', 'A.com', 'b.org'])).toEqual({ ok: true, patterns: ['a.com', 'b.org'] });
    expect(parseAllowlist('a.com')).toMatchObject({ ok: false });
    expect(parseAllowlist(BUILTIN_ALLOWLIST)).toEqual({ ok: true, patterns: BUILTIN_ALLOWLIST });
    // Organisation-specific hosts are an install's own addition (.env), never built in.
    expect(BUILTIN_ALLOWLIST).toEqual([
      'registry.npmjs.org',
      'pypi.org',
      'files.pythonhosted.org',
      'api.nuget.org',
      'github.com',
      'api.github.com',
      'codeload.github.com',
      '*.githubusercontent.com',
      'learn.microsoft.com',
    ]);
    expect(defaultAllowlist(['pkgs.example.org', ' *.pkgs.example.org ', 'not a host', 'github.com'])).toEqual([
      ...BUILTIN_ALLOWLIST,
      'pkgs.example.org',
      '*.pkgs.example.org',
    ]);
  });

  it('matches exact hosts, subdomain wildcards (not the apex) and ports', () => {
    expect(hostMatches('github.com', 443, 'github.com')).toBe(true);
    expect(hostMatches('GitHub.com.', 443, 'github.com')).toBe(true);
    expect(hostMatches('evilgithub.com', 443, 'github.com')).toBe(false);
    expect(hostMatches('raw.githubusercontent.com', 443, '*.githubusercontent.com')).toBe(true);
    expect(hostMatches('githubusercontent.com', 443, '*.githubusercontent.com')).toBe(false);
    expect(hostMatches('xgithubusercontent.com', 443, '*.githubusercontent.com')).toBe(false);
    expect(hostMatches('github.com', 80, 'github.com')).toBe(true);
    expect(hostMatches('github.com', 22, 'github.com')).toBe(false);
    expect(hostMatches('feed.example.org', 8443, 'feed.example.org:8443')).toBe(true);
    expect(hostMatches('feed.example.org', 443, 'feed.example.org:8443')).toBe(false);
  });

  it('modes: open lets anything through, allowlist adds the list to the model, none is the model only', () => {
    const list = ['pypi.org'];
    expect(egressAllowed('open', 'anything.example', 443, list)).toBe(true);
    expect(egressAllowed('host-only', 'pypi.org', 443, list)).toBe(true);
    expect(egressAllowed('host-only', 'api.anthropic.com', 443, list)).toBe(true);
    expect(egressAllowed('host-only', 'anything.example', 443, list)).toBe(false);
    expect(egressAllowed('none', 'pypi.org', 443, list)).toBe(false);
    expect(egressAllowed('none', 'api.anthropic.com', 443, list)).toBe(true);
  });

  it("the agent's own model host is always allowed, in Model only too", () => {
    const always = ['api.anthropic.com', 'host.docker.internal:11434'];
    expect(egressAllowed('none', 'host.docker.internal', 11434, [], always)).toBe(true);
    expect(egressAllowed('host-only', 'host.docker.internal', 11434, [], always)).toBe(true);
    expect(egressAllowed('none', 'host.docker.internal', 4000, [], always)).toBe(false);
    // The floor stays the floor when a model host is not known.
    expect(egressAllowed('none', 'host.docker.internal', 11434, [])).toBe(false);
  });

  it('derives the model host as the container dials it, and a pass-through for a host-local one', () => {
    expect(modelHostPattern({ endpoint: 'http://localhost:11434' })).toBe('host.docker.internal:11434');
    expect(modelHostPattern({ endpoint: 'http://127.0.0.1:4000/v1' })).toBe('host.docker.internal:4000');
    expect(modelHostPattern({ endpoint: 'https://llm.example.org/v1' })).toBe('llm.example.org:443');
    expect(modelHostPattern({ endpoint: 'http://203.0.113.20:11434' })).toBe('203.0.113.20:11434');
    expect(modelHostPattern({ endpoint: null })).toBeNull();
    expect(modelHostPattern(null)).toBeNull();
    expect(modelHostPattern({ endpoint: 'not a url' })).toBeNull();
    expect(modelPassthrough({ endpoint: 'http://localhost:11434' })).toEqual({
      port: 11434,
      target: { host: '127.0.0.1', port: 11434 },
    });
    expect(modelPassthrough({ endpoint: 'http://host.docker.internal:4000/v1' })).toEqual({
      port: 4000,
      target: { host: '127.0.0.1', port: 4000 },
    });
    expect(modelPassthrough({ endpoint: 'https://llm.example.org/v1' })).toBeNull();
    expect(modelPassthrough({ endpoint: null })).toBeNull();
  });

  it('every agent defaults to the allowlist: open only when chosen', () => {
    expect(effectiveEgressMode(null)).toBe('host-only');
    expect(effectiveEgressMode(undefined)).toBe('host-only');
    expect(effectiveEgressMode('something-else')).toBe('host-only');
    expect(effectiveEgressMode('host-only')).toBe('host-only');
    expect(effectiveEgressMode('open')).toBe('open');
    expect(effectiveEgressMode('none')).toBe('none');
  });
});

describe('isSafeEgressHost', () => {
  it('accepts DNS names and IP literals', () => {
    for (const h of [
      'api.github.com',
      'a.githubusercontent.com',
      'localhost',
      'x.example.',
      '10.0.0.5',
      '::1',
      'fe80::1',
    ])
      expect(isSafeEgressHost(h), h).toBe(true);
  });

  it('refuses anything that could carry a second request line into CONNECT', () => {
    for (const h of [
      '10.0.0.5:22 HTTP/1.1\r\nX: a.githubusercontent.com',
      '10.0.0.5:22 HTTP/1.1\nX: a.githubusercontent.com',
      'evil.example a.githubusercontent.com',
      '[::1]',
      'host:443',
      '',
      '-leading.example',
    ])
      expect(isSafeEgressHost(h), JSON.stringify(h)).toBe(false);
  });
});
