import { describe, expect, it } from 'vitest';

import { missingRegistrations } from './index.js';

/**
 * The comparison is extracted and pure because the interesting cases are about
 * WHICH providers count, and exercising those through a DB and a live registry
 * would test the plumbing instead of the rule.
 *
 * The failure this guards: a skill copies a provider file but its barrel-import
 * step does not run, so registration never happens. Everything compiles and
 * every test passes; the group pinned to that provider dies at spawn with
 * `Unknown provider`, hours later, in a container whose logs are gone. pi sat
 * that way for five days.
 */
describe('missingRegistrations', () => {
  it('flags a provider groups use that never registered', async () => {
    const missing = missingRegistrations([{ provider: 'pi', groups: 2 }], ['claude', 'grok']);
    expect(missing).toEqual([{ provider: 'pi', groups: 2 }]);
  });

  it('says nothing when everything in use is registered', async () => {
    expect(missingRegistrations([{ provider: 'grok', groups: 1 }], ['claude', 'grok'])).toEqual([]);
  });

  it('reports each unregistered provider separately', async () => {
    const missing = missingRegistrations(
      [
        { provider: 'pi', groups: 1 },
        { provider: 'codex', groups: 3 },
        { provider: 'grok', groups: 1 },
      ],
      ['claude', 'grok'],
    );
    expect(missing.map((m) => m.provider)).toEqual(['pi', 'codex']);
  });

  it('carries the group count, so the line says how much is affected', async () => {
    // "one group is broken" and "nine are" deserve different urgency from
    // whoever reads the log.
    expect(missingRegistrations([{ provider: 'pi', groups: 9 }], [])[0].groups).toBe(9);
  });

  it('ignores a null provider — that is the built-in default, not a gap', async () => {
    expect(missingRegistrations([{ provider: null, groups: 4 }], [])).toEqual([]);
  });

  it('is quiet on a fresh install with no groups', async () => {
    expect(missingRegistrations([], ['claude'])).toEqual([]);
  });
});
