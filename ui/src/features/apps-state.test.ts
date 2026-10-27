import { describe, expect, it } from 'vitest';
import {
  classifyChange,
  diskText,
  nextForRoute,
  parseEmailList,
  routeOptions,
  rowKey,
  whoOptions,
  widensAccess,
  type AppSetting,
} from './apps-state.js';
import { changedFields, connectLabel, errorField } from './publishing-state.js';

const s = (route: AppSetting['route'], who: AppSetting['who'] = 'only-me', emails: string[] = []): AppSetting => ({
  route,
  who,
  emails,
});

describe('classifyChange: a person narrows directly, widens through a card', () => {
  it('unpublishing is a narrowing; Off to Off is nothing', () => {
    expect(classifyChange(s('tailnet', 'signed-in'), s('off'))).toBe('narrow');
    expect(classifyChange(s('cloudflare', 'specific', ['a@x.io']), s('off'))).toBe('narrow');
    expect(classifyChange(s('off'), s('off'))).toBe('none');
  });

  it('publishing and any route change widen, even to Only me', () => {
    expect(classifyChange(s('off'), s('tailnet'))).toBe('widen');
    expect(classifyChange(s('off'), s('cloudflare'))).toBe('widen');
    expect(classifyChange(s('tailnet'), s('cloudflare'))).toBe('widen');
    expect(classifyChange(s('cloudflare', 'signed-in'), s('tailnet', 'only-me'))).toBe('widen');
  });

  it('who can open: wider is a card, narrower applies', () => {
    expect(classifyChange(s('tailnet', 'only-me'), s('tailnet', 'agent-members'))).toBe('widen');
    expect(classifyChange(s('tailnet', 'agent-members'), s('tailnet', 'signed-in'))).toBe('widen');
    expect(classifyChange(s('tailnet', 'signed-in'), s('tailnet', 'agent-members'))).toBe('narrow');
    expect(classifyChange(s('tailnet', 'signed-in'), s('tailnet', 'only-me'))).toBe('narrow');
    expect(classifyChange(s('tailnet', 'agent-members'), s('tailnet', 'agent-members'))).toBe('none');
  });

  it('specific people: adding anyone widens, removing narrows, reordering is nothing', () => {
    const ab = s('cloudflare', 'specific', ['a@x.io', 'b@x.io']);
    expect(classifyChange(ab, s('cloudflare', 'specific', ['a@x.io']))).toBe('narrow');
    expect(classifyChange(ab, s('cloudflare', 'specific', ['a@x.io', 'b@x.io', 'c@x.io']))).toBe('widen');
    // Swapping one person for another lets someone new in.
    expect(classifyChange(ab, s('cloudflare', 'specific', ['a@x.io', 'c@x.io']))).toBe('widen');
    expect(classifyChange(ab, s('cloudflare', 'specific', ['b@x.io', 'a@x.io']))).toBe('none');
  });

  it('specific against the fixed rules', () => {
    // Only me → named people lets the named in.
    expect(classifyChange(s('cloudflare', 'only-me'), s('cloudflare', 'specific', ['a@x.io']))).toBe('widen');
    // Members or everyone → named people is narrower.
    expect(classifyChange(s('cloudflare', 'signed-in'), s('cloudflare', 'specific', ['a@x.io']))).toBe('narrow');
    expect(classifyChange(s('cloudflare', 'agent-members'), s('cloudflare', 'specific', ['a@x.io']))).toBe('narrow');
    // Named people → members or everyone is wider; → only me is narrower.
    expect(classifyChange(s('cloudflare', 'specific', ['a@x.io']), s('cloudflare', 'agent-members'))).toBe('widen');
    expect(classifyChange(s('cloudflare', 'specific', ['a@x.io']), s('cloudflare', 'only-me'))).toBe('narrow');
  });

  it('widensAccess matches the order Only me < Specific < Members < Signed in', () => {
    expect(widensAccess({ who: 'only-me', emails: [] }, { who: 'signed-in', emails: [] })).toBe(true);
    expect(widensAccess({ who: 'signed-in', emails: [] }, { who: 'only-me', emails: [] })).toBe(false);
  });
});

describe('row controls', () => {
  it('route options: Off plus the routes that are on, and the row’s own route', () => {
    expect(routeOptions([], 'off').map((o) => o.value)).toEqual(['off']);
    expect(routeOptions(['cloudflare'], 'off').map((o) => o.label)).toEqual(['Off', 'Cloudflare']);
    expect(routeOptions(['cloudflare'], 'tailnet').map((o) => o.value)).toEqual(['off', 'tailnet', 'cloudflare']);
  });

  it('who options: Specific people… only on Cloudflare, nothing while Off', () => {
    expect(whoOptions('off')).toEqual([]);
    expect(whoOptions('tailnet').map((o) => o.label)).toEqual(['Only me', 'Agent members', 'Anyone signed in']);
    expect(whoOptions('cloudflare').map((o) => o.value)).toContain('specific');
  });

  it('a route change keeps the rule where it can, else Only me', () => {
    expect(nextForRoute({ route: 'off', who: 'only-me', emails: [] }, 'tailnet')).toEqual(s('tailnet'));
    expect(nextForRoute({ route: 'tailnet', who: 'agent-members', emails: [] }, 'cloudflare')).toEqual(
      s('cloudflare', 'agent-members'),
    );
    expect(nextForRoute({ route: 'cloudflare', who: 'specific', emails: ['a@x.io'] }, 'tailnet')).toEqual(s('tailnet'));
    expect(nextForRoute({ route: 'cloudflare', who: 'signed-in', emails: [] }, 'off').route).toBe('off');
  });

  it('parses a typed list of people', () => {
    expect(parseEmailList('B@x.io, a@x.io;  b@x.io nope')).toEqual({ emails: ['a@x.io', 'b@x.io'], bad: ['nope'] });
    expect(parseEmailList('')).toEqual({ emails: [], bad: [] });
  });

  it('keys rows by app, or by workload while unpublished', () => {
    expect(rowKey({ app: 'notes', workload: 'notes' })).toBe('app:notes');
    expect(rowKey({ app: null, workload: 'notes' })).toBe('w:notes');
  });

  it('disk figure', () => {
    expect(diskText(null)).toBe('');
    expect(diskText({ usedGb: 1.234, quotaGb: 20, level: 'ok' })).toBe('1.2 GB of 20 GB');
  });
});

describe('publishing panel decisions', () => {
  it('Connect until the credential is in place, then Reconnect', () => {
    expect(connectLabel({ needsConnect: true })).toBe('Connect…');
    expect(connectLabel({ needsConnect: false })).toBe('Reconnect…');
  });

  it('sends only the Cloudflare fields that changed', () => {
    const saved = { domain: 'apps.net', accountId: 'a', zoneId: 'z', teamDomain: 't.cloudflareaccess.com' };
    expect(changedFields(saved, { ...saved })).toEqual({});
    expect(changedFields(saved, { ...saved, domain: ' other.net ' })).toEqual({ domain: 'other.net' });
  });

  it('reads the refused field from the server’s answer', () => {
    expect(errorField({ body: { field: 'domain' } })).toBe('domain');
    expect(errorField(new Error('x'))).toBe('');
  });
});
