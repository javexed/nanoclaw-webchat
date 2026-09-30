import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from './db/connection.js';
import { log } from './log.js';
import { registerModuleSweep } from './module-sweep.js';

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeDb();
});

describe('registerModuleSweep', () => {
  it('skips quietly while no database is open', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(log, 'warn');
    const fn = vi.fn(async () => {});
    registerModuleSweep('probe-closed', fn, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('runs once the database is open, and logs a failing task', async () => {
    await initTestDb();
    vi.useFakeTimers();
    const warn = vi.spyOn(log, 'warn');
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    registerModuleSweep('probe-open', fn, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Module sweep failed', { task: 'probe-open', err: 'Error: boom' });
  });
});
