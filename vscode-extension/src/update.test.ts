import { describe, expect, it } from 'vitest';

import { isNewer, planUpdate } from './update.js';

const sha = 'a'.repeat(64);

describe('served updates', () => {
  it('compares versions numerically and never treats junk as newer', () => {
    expect(isNewer('0.7.3', '0.7.2')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.7.2', '0.7.2')).toBe(false);
    expect(isNewer('0.7.1', '0.7.2')).toBe(false);
    expect(isNewer('x', '0.7.2')).toBe(false);
  });

  it('plans nothing unless the offer is newer, verifiable, not yet offered, and updates are on', () => {
    const offer = { version: '0.7.3', sha256: sha };
    expect(planUpdate(undefined, '0.7.2', 'prompt', new Set())).toEqual({ action: 'none' });
    expect(planUpdate(offer, '0.7.3', 'prompt', new Set())).toEqual({ action: 'none' });
    expect(planUpdate(offer, '0.7.2', 'off', new Set())).toEqual({ action: 'none' });
    expect(planUpdate({ ...offer, sha256: 'nope' }, '0.7.2', 'prompt', new Set())).toEqual({ action: 'none' });
    expect(planUpdate(offer, '0.7.2', 'prompt', new Set(['0.7.3']))).toEqual({ action: 'none' });
    expect(planUpdate(offer, '0.7.2', 'prompt', new Set())).toEqual({ action: 'prompt', offer });
    expect(planUpdate(offer, '0.7.2', 'auto', new Set())).toEqual({ action: 'install', offer });
  });
});
