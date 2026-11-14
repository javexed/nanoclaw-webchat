import { describe, expect, it } from 'vitest';

import { computeAvailable, OS_RESERVE_MB, OTHER_BUFFER, PEAK_DAYS, recentOther, updatePeaks, type Peaks } from './capacity.js';

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

  it("is total minus other software's current use plus 20%, minus the OS reserve", () => {
    const a = computeAvailable(totals, { memMb: 5000, cpus: 1 });
    expect(a.memMb).toBe(16000 - 5000 * (1 + OTHER_BUFFER) - OS_RESERVE_MB);
    expect(a.cpus).toBe(2.55);
    expect(a).toMatchObject({ memBy: 'auto', cpusBy: 'auto' });
  });

  it('with no reports yet, is nearly the whole box: total minus the OS reserve', () => {
    expect(computeAvailable(totals, null)).toMatchObject({ memMb: 14976, cpus: 3.75 });
  });

  it('is never below zero when other software uses (nearly) everything', () => {
    const a = computeAvailable(totals, { memMb: 15900, cpus: 3.9 });
    expect(a.memMb).toBe(0);
    expect(a.cpus).toBe(0);
  });

  it('an owner cap lowers it, and only where it is lower', () => {
    const a = computeAvailable(totals, null, { memMb: 8000, cpus: 8 });
    expect(a).toMatchObject({ memMb: 8000, memBy: 'cap', cpus: 3.75, cpusBy: 'auto' });
  });

  it('a cap of zero means none of it', () => {
    expect(computeAvailable(totals, null, { memMb: 0, cpus: 0 })).toMatchObject({
      memMb: 0,
      cpus: 0,
      memBy: 'cap',
      cpusBy: 'cap',
    });
  });
});

describe('other software at its recent peak (automatic moves)', () => {
  const now = Date.parse('2026-11-13T20:44:00Z');
  const peaks: Peaks = {
    '2026-11-10': { memMb: 14349, cpus: 4 },
    '2026-11-12': { memMb: 8165, cpus: 3.4 },
    '2026-11-13': { memMb: 12744, cpus: 3.9 },
  };
  it('takes the highest of now, today and yesterday, never older days', () => {
    expect(recentOther({ memMb: 7000, cpus: 1 }, peaks, now)).toEqual({ memMb: 12744, cpus: 3.9 });
    expect(recentOther({ memMb: 13000, cpus: 1 }, peaks, now).memMb).toBe(13000);
    expect(recentOther({ memMb: 100, cpus: 0.1 }, {}, now)).toEqual({ memMb: 100, cpus: 0.1 });
  });
  it('leaves a busy shared worker no room during a quiet moment', () => {
    const quiet = computeAvailable({ memMb: 15933, cpus: 4 }, { memMb: 7000, cpus: 1 });
    const atPeak = computeAvailable({ memMb: 15933, cpus: 4 }, recentOther({ memMb: 7000, cpus: 1 }, peaks, now));
    expect(quiet.memMb).toBeGreaterThan(5000);
    expect(atPeak.memMb).toBe(0);
  });
});

