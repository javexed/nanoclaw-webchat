import { describe, expect, it } from 'vitest';

import { prunable, stampOf, stampTime } from './backup.js';

describe('backups', () => {
  it('keeps the newest three finished, drops unfinished ones', () => {
    const s = ['20261020T020000Z', '20261021T020000Z', '20261022T020000Z', '20261023T020000Z', '20261023T030000Z'];
    const done = new Set(s.slice(0, 4));
    expect(prunable(s, done).sort()).toEqual(['20261020T020000Z', '20261023T030000Z']);
    expect(prunable(s.slice(0, 2), new Set(s.slice(0, 2)))).toEqual([]);
  });

  it('round-trips stamps', () => {
    const d = new Date('2026-10-23T02:03:04.567Z');
    expect(stampOf(d)).toBe('20261023T020304Z');
    expect(stampTime(stampOf(d))).toBe(Date.parse('2026-10-23T02:03:04Z'));
  });
});
