import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from './log.js';
import { _resetMailboxBusyWarnings, isSqliteBusy, skipMailboxBusy } from './mailbox-busy.js';

const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

afterEach(() => {
  vi.restoreAllMocks();
  _resetMailboxBusyWarnings();
});

describe('mailbox busy locks are transient', () => {
  it('recognises SQLite busy codes and nothing else', () => {
    expect(isSqliteBusy(busy)).toBe(true);
    expect(isSqliteBusy(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(true);
    expect(isSqliteBusy(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(false);
    expect(isSqliteBusy(new Error('database is locked'))).toBe(false); // no code: not assumed
    expect(isSqliteBusy(null)).toBe(false);
  });

  it('skips and warns once per session per minute, counting the rounds it swallowed', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const t0 = 1_000_000;
    expect(skipMailboxBusy('delivery', 'ag', 's1', busy, t0)).toBe(true);
    expect(skipMailboxBusy('delivery', 'ag', 's1', busy, t0 + 1_000)).toBe(true);
    expect(skipMailboxBusy('delivery', 'ag', 's1', busy, t0 + 2_000)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(skipMailboxBusy('delivery', 'ag', 's1', busy, t0 + 61_000)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][1]).toMatchObject({ skippedSinceLastWarning: 2 });
    // Another session, or the sweep, warns on its own.
    skipMailboxBusy('delivery', 'ag', 's2', busy, t0 + 61_500);
    skipMailboxBusy('sweep', 'ag', 's1', busy, t0 + 61_500);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('leaves every other error to the caller', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(skipMailboxBusy('sweep', 'ag', 's1', new Error('boom'))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
