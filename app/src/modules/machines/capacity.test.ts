import { describe, expect, it } from 'vitest';

import { computeAvailable, HEADROOM, PEAK_DAYS, updatePeaks, type Peaks } from './capacity.js';

const day = (d: string, h = 12): number => Date.parse(`${d}T${String(h).padStart(2, '0')}:00:00Z`);

describe('peaks of other software', () => {
  it('keeps the highest use per day', () => {
    let p: Peaks = {};
    p = updatePeaks(p, { memMb: 3000, cpus: 0.5 }, day('2026-10-01', 9));
    p = updatePeaks(p, { memMb: 5000, cpus: 0.2 }, day('2026-10-01', 14));
    p = updatePeaks(p, { memMb: 4000, cpus: 1.5 }, day('2026-10-01', 20));
    expect(p).toEqual({ '2026-10-01': { memMb: 5000, cpus: 1.5 } });
  });

  it('keeps only the last 7 days', () => {
    let p: Peaks = {};
    for (let i = 1; i <= 9; i++) p = updatePeaks(p, { memMb: i * 1000, cpus: 0 }, day(`2026-10-0${i}`));
    expect(Object.keys(p)).toHaveLength(PEAK_DAYS);
    expect(Object.keys(p)[0]).toBe('2026-10-03');
  });

  it('never records negative use (NanoClaw counted twice, a racy read)', () => {
    const p = updatePeaks({}, { memMb: -200, cpus: -0.1 }, day('2026-10-01'));
    expect(p['2026-10-01']).toEqual({ memMb: 0, cpus: 0 });
  });
});

describe('what NanoClaw may use', () => {
  const totals = { memMb: 16000, cpus: 4 };

  it('is total minus the 7-day peak minus 15% headroom', () => {
    const peaks: Peaks = { '2026-10-01': { memMb: 4000, cpus: 1 }, '2026-10-02': { memMb: 6000, cpus: 0.5 } };
    const a = computeAvailable(totals, peaks);
    expect(a.memMb).toBe(16000 - 6000 - HEADROOM * 16000);
    expect(a.cpus).toBeCloseTo(4 - 1 - 0.6, 2);
    expect(a).toMatchObject({ memBy: 'auto', cpusBy: 'auto' });
  });

  it('with no reports yet, is total minus headroom', () => {
    expect(computeAvailable(totals, {})).toMatchObject({ memMb: 13600, cpus: 3.4 });
  });

  it('is never below zero when other software uses (nearly) everything', () => {
    const a = computeAvailable(totals, { '2026-10-01': { memMb: 15900, cpus: 3.9 } });
    expect(a.memMb).toBe(0);
    expect(a.cpus).toBe(0);
  });

  it('an owner cap lowers it, and only where it is lower', () => {
    const a = computeAvailable(totals, {}, { memMb: 8000, cpus: 8 });
    expect(a).toMatchObject({ memMb: 8000, memBy: 'cap', cpus: 3.4, cpusBy: 'auto' });
  });

  it('a cap of zero means none of it', () => {
    expect(computeAvailable(totals, {}, { memMb: 0, cpus: 0 })).toMatchObject({
      memMb: 0,
      cpus: 0,
      memBy: 'cap',
      cpusBy: 'cap',
    });
  });
});
