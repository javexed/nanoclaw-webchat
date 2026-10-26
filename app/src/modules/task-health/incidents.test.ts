/**
 * Incident bookkeeping and alert text, plus the reminder-interval setting.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { alertText, DEFAULT_REMINDER_HOURS, recordVerdict, reminderHours } from './incidents.js';

const T0 = Date.parse('2026-10-01T09:00:00.000Z');
const H = 3_600_000;
const fail = (signature = 'model-error', reason: string | null = 'boom') =>
  ({ outcome: 'failed', signature, reason }) as const;

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
});
afterEach(() => closeDb());

describe('reminder interval', () => {
  it('defaults to 24 h and accepts a positive number of hours', () => {
    expect(DEFAULT_REMINDER_HOURS).toBe(24);
    expect(reminderHours(undefined)).toBe(24);
    expect(reminderHours('')).toBe(24);
    expect(reminderHours('6')).toBe(6);
    expect(reminderHours('0.5')).toBe(0.5);
  });

  it('falls back to the default on nonsense', () => {
    expect(reminderHours('0')).toBe(24);
    expect(reminderHours('-3')).toBe(24);
    expect(reminderHours('daily')).toBe(24);
  });

  it('a configured interval governs the reminder', async () => {
    expect((await recordVerdict('t-1', 'ag', fail(), new Date(T0), 6))?.kind).toBe('opened');
    expect(await recordVerdict('t-1', 'ag', fail(), new Date(T0 + 5 * H), 6)).toBeNull();
    expect((await recordVerdict('t-1', 'ag', fail(), new Date(T0 + 6 * H), 6))?.kind).toBe('reminder');
    expect(await recordVerdict('t-1', 'ag', fail(), new Date(T0 + 7 * H), 6)).toBeNull();
  });
});

describe('recordVerdict', () => {
  it('success with no open incident says nothing', async () => {
    expect(await recordVerdict('t-1', 'ag', { outcome: 'ok' }, new Date(T0))).toBeNull();
  });

  it('a recovered incident can reopen, and alerts again', async () => {
    await recordVerdict('t-1', 'ag', fail(), new Date(T0));
    expect((await recordVerdict('t-1', 'ag', { outcome: 'ok' }, new Date(T0 + H)))?.kind).toBe('recovered');
    expect((await recordVerdict('t-1', 'ag', fail(), new Date(T0 + 2 * H)))?.kind).toBe('opened');
  });

  it('incidents are per task', async () => {
    expect((await recordVerdict('t-1', 'ag', fail(), new Date(T0)))?.kind).toBe('opened');
    expect((await recordVerdict('t-2', 'ag', fail(), new Date(T0)))?.kind).toBe('opened');
  });
});

describe('alertText', () => {
  const at = (iso: string) => iso.slice(11, 16);
  const base = { seriesId: 'daily-brief-1a2b', signature: 'model-error', openedAt: '2026-10-01T09:00:00.000Z' };

  it('names the task and the reason', () => {
    expect(alertText({ ...base, kind: 'opened', reason: 'model not found', failures: 1 }, at)).toBe(
      'Scheduled task daily-brief-1a2b failed: model not found',
    );
    expect(alertText({ ...base, kind: 'opened', reason: null, failures: 1 }, at)).toBe(
      'Scheduled task daily-brief-1a2b failed.',
    );
  });

  it('a reminder counts the failures since the incident opened', () => {
    expect(alertText({ ...base, kind: 'reminder', reason: 'model not found', failures: 5 }, at)).toBe(
      'Scheduled task daily-brief-1a2b is still failing — 5 failed runs since 09:00: model not found',
    );
  });

  it('recovery says how many runs failed', () => {
    expect(alertText({ ...base, kind: 'recovered', reason: 'x', failures: 1 }, at)).toBe(
      'Scheduled task daily-brief-1a2b is working again after 1 failed run.',
    );
    expect(alertText({ ...base, kind: 'recovered', reason: 'x', failures: 3 }, at)).toContain('after 3 failed runs');
  });
});
