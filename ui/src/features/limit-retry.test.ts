import { describe, expect, it } from 'vitest';

import { canCancelLimitRetry, conflictRetry, limitRetryTime, limitRetryView } from './limit-retry.js';

const NOW = Date.parse('2031-01-01T04:00:00.000Z');
const RESET = NOW + 60 * 60 * 1000;

describe('the control on a rate-limit notice', () => {
  it('offers a retry while the reset is ahead', () => {
    const row = { limitResetsAt: RESET, limitThread: 'main' };
    expect(limitRetryView(row, [row], NOW)).toBe('offer');
  });

  it('shows nothing on a message with no reset, or once the reset has passed', () => {
    expect(limitRetryView({}, [], NOW)).toBeNull();
    expect(limitRetryView({ limitResetsAt: NOW - 1, limitThread: 'main' }, [], NOW)).toBeNull();
  });

  it('shows the pending retry on its own notice', () => {
    const row = { limitResetsAt: RESET, limitRetryAt: RESET + 30_000, limitThread: 'main' };
    expect(limitRetryView(row, [row], NOW)).toBe('scheduled');
  });

  it('offers nothing on another notice in a thread that already has one pending', () => {
    const pending = { limitResetsAt: RESET, limitRetryAt: RESET + 30_000, limitThread: 'main' };
    const other = { limitResetsAt: RESET + 1000, limitThread: 'main' };
    const elsewhere = { limitResetsAt: RESET, limitThread: 't1' };
    const rows = [pending, other, elsewhere];
    expect(limitRetryView(other, rows, NOW)).toBeNull();
    expect(limitRetryView(elsewhere, rows, NOW)).toBe('offer');
  });

  it('dates a retry that is not today', () => {
    expect(limitRetryTime(NOW, NOW)).not.toContain(',');
    expect(limitRetryTime(NOW + 3 * 24 * 60 * 60 * 1000, NOW)).toContain(',');
  });

  it('offers Cancel only to who scheduled it, or a room admin', () => {
    expect(canCancelLimitRetry('Alice', 'Alice', false)).toBe(true);
    expect(canCancelLimitRetry('Alice', 'Bob', false)).toBe(false);
    expect(canCancelLimitRetry('Alice', 'Bob', true)).toBe(true);
    expect(canCancelLimitRetry(null, '', false)).toBe(false);
  });

  it('reads the pending retry a conflict carries', () => {
    expect(
      conflictRetry({ error: 'A retry is already scheduled', retry_at: RESET, notice_id: 'n1', by: 'Alice' }),
    ).toEqual({
      noticeId: 'n1',
      retryAt: RESET,
      by: 'Alice',
    });
    expect(conflictRetry({ error: 'The limit has already reset', retry_at: null })).toBeNull();
    expect(conflictRetry(undefined)).toBeNull();
  });
});
