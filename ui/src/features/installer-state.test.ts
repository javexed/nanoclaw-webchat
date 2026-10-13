import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installLogText, installProgressLine } from './installer-state.js';

describe('install progress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('says which step, of how many, and for how long', () => {
    expect(
      installProgressLine({ stepIndex: 2, stepCount: 6, stepLabel: 'Building', startedAt: 1_000_000_000 - 75_000 }),
    ).toBe('Step 2 of 6 — Building · 1m 15s');
  });

  it('without a step count or a start, still says it is installing', () => {
    expect(installProgressLine({})).toBe('Installing · 0s');
  });

  it('never shows negative time for a start just ahead of this clock', () => {
    expect(installProgressLine({ startedAt: 1_000_000_000 + 5_000 })).toBe('Installing · 0s');
  });

  it('while running, the progress line heads the log tail; after, only the tail', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const running = installLogText({ running: true, stepIndex: 1, stepCount: 2, lines }, 3).split('\n');
    expect(running).toEqual(['Step 1 of 2 · 0s', 'line 17', 'line 18', 'line 19']);
    expect(installLogText({ running: false, lines }, 2)).toBe('line 18\nline 19');
    expect(installLogText({ running: false, lines: 'not a list' })).toBe('');
  });
});
