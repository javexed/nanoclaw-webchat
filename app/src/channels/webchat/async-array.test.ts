import { describe, expect, it } from 'vitest';

import { everyAsync, filterAsync, someAsync } from './async-array.js';

// The bug these exist to prevent: a native filter with an async predicate keeps
// EVERYTHING, because it tests a Promise. These tests state that difference
// directly, so the reason the helpers exist cannot be lost to a later cleanup.

describe('async array predicates', () => {
  const even = async (n: number) => n % 2 === 0;

  it('filters on the RESOLVED value, unlike a native filter', async () => {
    // Documented for contrast: this is what the codebase was doing.
    expect([1, 2, 3].filter((n) => even(n))).toEqual([1, 2, 3]);
  });

  it('filterAsync keeps only what the predicate actually accepts', async () => {
    await expect(filterAsync([1, 2, 3, 4], even)).resolves.toEqual([2, 4]);
  });

  it('someAsync is false when nothing matches', async () => {
    await expect(someAsync([1, 3, 5], even)).resolves.toBe(false);
    await expect(someAsync([1, 3, 4], even)).resolves.toBe(true);
  });

  it('everyAsync is false when one fails', async () => {
    await expect(everyAsync([2, 4, 5], even)).resolves.toBe(false);
    await expect(everyAsync([2, 4, 6], even)).resolves.toBe(true);
  });

  it('short-circuits, so a denied check does not run every remaining query', async () => {
    const seen: number[] = [];
    await someAsync([1, 2, 3], async (n) => {
      seen.push(n);
      return n === 2;
    });
    expect(seen).toEqual([1, 2]);
  });

  it('accepts a sync predicate too, so call sites need not care', async () => {
    await expect(filterAsync([1, 2, 3], (n) => n > 1)).resolves.toEqual([2, 3]);
  });
});
