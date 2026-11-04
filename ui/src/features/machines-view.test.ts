import { describe, expect, it } from 'vitest';

import {
  ago,
  availableLine,
  capForm,
  isolationLine,
  needsWorker,
  placedLine,
  statusOf,
  usageLine,
  type MachineRow,
} from './machines-view.js';

const row = (over: Partial<MachineRow> = {}): MachineRow => ({
  id: 'm-1',
  name: 'app1',
  role: 'worker',
  state: 'ready',
  healthy: true,
  facts: { cpus: 4, memTotalMb: 16384 },
  health: { cpus: 4, memTotalMb: 16384, memUsedMb: 2048, cpuUsed: 0.4, diskTotalGb: 64, diskFreeGb: 40 },
  lastReport: Date.now(),
  cap: { memMb: null, cpus: null },
  available: { memMb: 11264, cpus: 2.6, memBy: 'auto', cpusBy: 'auto' },
  ...over,
});

describe('a machine row', () => {
  it('status: revoked beats offline beats draining', () => {
    expect(statusOf(row())).toBe('ready');
    expect(statusOf(row({ state: 'draining' }))).toBe('draining');
    expect(statusOf(row({ state: 'draining', healthy: false }))).toBe('offline');
    expect(statusOf(row({ state: 'revoked', healthy: false }))).toBe('revoked');
  });

  it('usage from the last report, or the join facts before one', () => {
    expect(usageLine(row())).toBe('2 GB/16 GB · 0.4/4 CPU · 40 GB free');
    expect(usageLine(row({ health: null }))).toBe('16 GB · 4 CPU');
  });

  it('marks where the owner cap applies', () => {
    expect(availableLine(row())).toBe('11 GB, 2.6 CPU');
    expect(availableLine(row({ available: { memMb: 4096, cpus: 2.6, memBy: 'cap', cpusBy: 'auto' } }))).toBe(
      '4 GB (cap), 2.6 CPU',
    );
  });

  it('last report in plain words', () => {
    const now = 1_000_000_000;
    expect(ago(null, now)).toBe('never');
    expect(ago(now - 20_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ago(now - 3 * 3600_000, now)).toBe('3 h ago');
  });

  it('cap form: empty means none', () => {
    expect(capForm(row())).toEqual({ memGb: '', cpus: '' });
    expect(capForm(row({ cap: { memMb: 6144, cpus: 1.5 } }))).toEqual({ memGb: '6', cpus: '1.5' });
  });

  it('asks for the worker service only for a reporting worker without a link', () => {
    expect(needsWorker(row({ linked: false }))).toBe(true);
    expect(needsWorker(row({ linked: true }))).toBe(false);
    expect(needsWorker(row({ linked: false, healthy: false }))).toBe(false);
    expect(needsWorker(row({ linked: false, state: 'revoked' }))).toBe(false);
    expect(needsWorker(row())).toBe(false);
  });

  it('reads a placed workload with its reason', () => {
    expect(placedLine({ name: 'demo', state: 'running', memoryMb: 2048, reason: 'M-A: most free memory' })).toBe(
      'demo · 2 GB · running — M-A: most free memory',
    );
    expect(placedLine({ name: 'x', state: 'stopped', memoryMb: 512, reason: null })).toBe('x · 0.5 GB · stopped');
  });
});

describe('a worker row: isolation', () => {
  it('one short line per state; the host-rules fix only when it got through', () => {
    const at = Date.now();
    expect(isolationLine(row({ isolation: { status: 'ok', at } }))).toEqual({
      text: 'Isolated',
      tone: 'ok',
      fix: false,
    });
    expect(isolationLine(row({ isolation: { status: 'open', at } }))).toEqual({
      text: 'Not isolated — host rules missing',
      tone: 'bad',
      fix: true,
    });
    expect(isolationLine(row({ isolation: { status: 'unknown', at: null } }))?.text).toBe('Not checked yet');
    expect(isolationLine(row({ isolation: { status: 'stale', at } }))?.text).toBe('Not checked recently');
  });

  it('counts the stacks the worker stopped', () => {
    const r = row({
      isolation: { status: 'open', at: Date.now() },
      placed: [
        { name: 'a', state: 'stopped', memoryMb: 512, reason: null, error: 'stopped on its worker' },
        { name: 'b', state: 'stopped', memoryMb: 512, reason: null, error: null },
        { name: 'c', state: 'running', memoryMb: 512, reason: null },
      ],
    });
    expect(isolationLine(r)?.text).toBe('Not isolated — host rules missing · 1 stopped');
  });

  it('none for a revoked machine or a server without the field', () => {
    expect(isolationLine(row({ state: 'revoked', isolation: { status: 'open', at: 1 } }))).toBeNull();
    expect(isolationLine(row())).toBeNull();
  });
});
