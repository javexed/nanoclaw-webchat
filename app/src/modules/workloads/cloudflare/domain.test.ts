import { describe, expect, it } from 'vitest';

import { registrableDomain, sameSite } from './domain.js';

describe('registrable domains (minimal public suffix check)', () => {
  it('takes one label above the suffix', () => {
    expect(registrableDomain('apps.example.com')).toBe('example.com');
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('x.example.com.au')).toBe('example.com.au');
    expect(registrableDomain('Notes.Example.NET.')).toBe('example.net');
    expect(registrableDomain('nanoclaw.tail1234.ts.net')).toBe('tail1234.ts.net');
    expect(registrableDomain('me.github.io')).toBe('me.github.io');
  });

  it('gives nothing for a bare suffix or a non-name', () => {
    for (const h of ['com', 'co.uk', 'github.io', '198.51.100.1', '', 'exa mple.com'])
      expect(registrableDomain(h)).toBe('');
  });

  it('says whether two names are one site', () => {
    expect(sameSite('chat.example.com', 'apps.example.com')).toBe(true);
    expect(sameSite('chat.example.com', 'example.com')).toBe(true);
    expect(sameSite('chat.example.com', 'example-apps.com')).toBe(false);
    expect(sameSite('a.example.co.uk', 'b.other.co.uk')).toBe(false);
    expect(sameSite('alice.github.io', 'bob.github.io')).toBe(false);
    expect(sameSite('com', 'com')).toBe(false);
  });
});
