/**
 * Session retention wiring: the sweep is off by default and throttled, VACUUM
 * is allowed at most weekly, and `ncl sessions prune` is a host-only verb on
 * the sessions resource.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prune = vi.hoisted(() => vi.fn());
vi.mock('../../session-retention.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-retention.js')>()),
  pruneSessions: prune,
}));

import '../../cli/resources/sessions.js';
import { getResource } from '../../cli/crud.js';
import { lookup } from '../../cli/registry.js';
import {
  PRUNE_EVERY_MS,
  registerSessionsPrune,
  resetRetentionSchedule,
  retentionTick,
  VACUUM_EVERY_MS,
} from './index.js';

const report = (over: Record<string, unknown> = {}) => ({
  days: 90,
  dryRun: false,
  sessions: [],
  bytes: 0,
  kept: {},
  errors: [],
  centralFreeRatio: 0,
  vacuumed: false,
  ...over,
});

const prior = process.env.NANOCLAW_SESSION_KEEP_DAYS;
beforeEach(() => {
  prune.mockReset();
  prune.mockImplementation(async (opts: { dryRun?: boolean; days: number }) =>
    report({ dryRun: opts.dryRun ?? false, days: opts.days }),
  );
  resetRetentionSchedule();
});
afterEach(() => {
  if (prior === undefined) delete process.env.NANOCLAW_SESSION_KEEP_DAYS;
  else process.env.NANOCLAW_SESSION_KEEP_DAYS = prior;
});

describe('retention sweep', () => {
  it('does nothing while retention is off', async () => {
    delete process.env.NANOCLAW_SESSION_KEEP_DAYS;
    expect(await retentionTick()).toBeNull();
    expect(prune).not.toHaveBeenCalled();
  });

  it('prunes at most every PRUNE_EVERY_MS and allows VACUUM at most weekly', async () => {
    process.env.NANOCLAW_SESSION_KEEP_DAYS = '90';
    prune.mockResolvedValueOnce(report({ vacuumed: true }));
    const t0 = 1_000_000_000_000;
    expect(await retentionTick(t0)).not.toBeNull();
    expect(prune).toHaveBeenLastCalledWith({ days: 90, allowVacuum: true });
    expect(await retentionTick(t0 + PRUNE_EVERY_MS - 1)).toBeNull();
    expect(await retentionTick(t0 + PRUNE_EVERY_MS)).not.toBeNull();
    expect(prune).toHaveBeenLastCalledWith({ days: 90, allowVacuum: false });
    await retentionTick(t0 + VACUUM_EVERY_MS);
    expect(prune).toHaveBeenLastCalledWith({ days: 90, allowVacuum: true });
    expect(prune).toHaveBeenCalledTimes(3);
  });
});

describe('ncl sessions prune', () => {
  it('registers once as a host-only verb of the sessions resource', () => {
    registerSessionsPrune();
    registerSessionsPrune();
    const cmd = lookup('sessions-prune');
    expect(cmd).toMatchObject({ hostOnly: true, resource: 'sessions', action: 'sessions.prune' });
    expect(Object.keys(getResource('sessions')!.customOperations!)).toContain('prune');
  });

  it('takes --dry-run and --days, and refuses to run with retention off and no --days', async () => {
    registerSessionsPrune();
    const cmd = lookup('sessions-prune')!;
    const ctx = { caller: 'host' } as never;
    delete process.env.NANOCLAW_SESSION_KEEP_DAYS;
    await expect(cmd.handler(cmd.parseArgs({}), ctx)).rejects.toThrow(/retention is off/);
    await cmd.handler(cmd.parseArgs({ 'dry-run': true, days: '30' }), ctx);
    expect(prune).toHaveBeenLastCalledWith({ days: 30, dryRun: true });
    process.env.NANOCLAW_SESSION_KEEP_DAYS = '90';
    await cmd.handler(cmd.parseArgs({}), ctx);
    expect(prune).toHaveBeenLastCalledWith({ days: 90, dryRun: false });
    expect(() => cmd.parseArgs({ force: true })).toThrow(/unknown flag --force/);
    await expect(cmd.handler(cmd.parseArgs({ days: '1.5' }), ctx)).rejects.toThrow(/whole number/);
  });
});
