import { describe, expect, it } from 'vitest';

import { STT_MIN_SEGMENT_MS, STT_MIN_VOICED_MS, STT_RMS_FLOOR, frameRms, segmentWorthSending } from './stt-gate.js';

describe('frameRms', () => {
  it('is 0 for silence and an empty frame, ~amplitude/√2 for a sine', () => {
    expect(frameRms(new Int16Array(128))).toBe(0);
    expect(frameRms(new Int16Array(0))).toBe(0);
    const sine = Int16Array.from({ length: 1280 }, (_, i) => Math.round(Math.sin((i / 1280) * 20 * Math.PI) * 0x4000));
    expect(frameRms(sine)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('keeps faint room noise under the speech floor', () => {
    const hiss = Int16Array.from({ length: 128 }, (_, i) => (i % 2 ? 200 : -200));
    expect(frameRms(hiss)).toBeLessThan(STT_RMS_FLOOR);
  });
});

describe('segmentWorthSending', () => {
  it('drops a click: a frame or two of voice in a long segment', () => {
    expect(segmentWorthSending(16, 5000)).toBe(false);
  });

  it('drops a segment with no voice at all', () => {
    expect(segmentWorthSending(0, 5000)).toBe(false);
  });

  it('sends a spoken word', () => {
    expect(segmentWorthSending(400, 1200)).toBe(true);
  });

  it('boundaries are inclusive', () => {
    expect(segmentWorthSending(STT_MIN_VOICED_MS, STT_MIN_SEGMENT_MS)).toBe(true);
    expect(segmentWorthSending(STT_MIN_VOICED_MS - 1, 2000)).toBe(false);
    expect(segmentWorthSending(STT_MIN_VOICED_MS, STT_MIN_SEGMENT_MS - 1)).toBe(false);
  });
});
