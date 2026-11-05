import { describe, expect, it } from 'vitest';

import { latestOnly } from './latest.js';

describe('latestOnly', () => {
  it('only the newest ticket is current', () => {
    const l = latestOnly();
    const a = l.start();
    const b = l.start();
    expect(l.current(a)).toBe(false);
    expect(l.current(b)).toBe(true);
  });

  it('a slow earlier choice does not land after a later one', async () => {
    const l = latestOnly();
    let saved = '';
    const pick = async (model: string, delay: number) => {
      const t = l.start();
      await new Promise((r) => setTimeout(r, delay));
      if (l.current(t)) saved = model;
    };
    await Promise.all([pick('a', 30), pick('b', 5)]);
    expect(saved).toBe('b');
  });
});
