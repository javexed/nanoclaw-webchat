import { afterEach, describe, expect, it, vi } from 'vitest';

import { autoSignInDue, frontDoorWantsSignIn, lastAutoSignIn } from './session-expiry.js';

const MIN = 60_000;

describe('going to the sign-in without a click', () => {
  const base = { visible: true, draft: false, now: 10 * MIN, last: 0 };

  it('goes when the tab is in view, nothing is unsent, and it has not just gone', () => {
    expect(autoSignInDue(base)).toBe(true);
  });

  it('never loses work: not with a draft, not in a background tab', () => {
    expect(autoSignInDue({ ...base, draft: true })).toBe(false);
    expect(autoSignInDue({ ...base, visible: false })).toBe(false);
  });

  it('not twice within two minutes, so a sign-in that does not take cannot loop', () => {
    expect(autoSignInDue({ ...base, last: base.now - MIN })).toBe(false);
    expect(autoSignInDue({ ...base, last: base.now - 2 * MIN - 1 })).toBe(true);
  });

  it('reads a junk stored time as never, instead of blocking the redirect for good', () => {
    expect(lastAutoSignIn(null)).toBe(0);
    expect(lastAutoSignIn('1790000000000')).toBe(1790000000000);
    for (const junk of ['abc', '', 'NaN', '-5', 'Infinity']) expect(lastAutoSignIn(junk)).toBe(0);
    expect(autoSignInDue({ ...base, last: lastAutoSignIn('abc') })).toBe(true);
  });
});

describe('telling an expired sign-in from a server that is down', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (fn: () => Promise<unknown>) => vi.stubGlobal('fetch', vi.fn(fn));

  it('a redirect (the front door wants a sign-in) is an expired session', async () => {
    respond(async () => ({ type: 'opaqueredirect' }));
    expect(await frontDoorWantsSignIn()).toBe(true);
  });

  it('an answer, or no answer at all, is not', async () => {
    respond(async () => ({ type: 'basic', ok: true }));
    expect(await frontDoorWantsSignIn()).toBe(false);
    respond(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await frontDoorWantsSignIn()).toBe(false);
  });

  it('asks without following redirects, so a login page cannot answer for the app', async () => {
    const f = vi.fn(async () => ({ type: 'basic' }));
    vi.stubGlobal('fetch', f);
    await frontDoorWantsSignIn();
    expect(f).toHaveBeenCalledWith('/api/auth/check', expect.objectContaining({ redirect: 'manual' }));
  });
});
