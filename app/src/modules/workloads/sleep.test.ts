/**
 * Idle stacks sleep and wake: who is due, the sweep stops and marks them,
 * a wake starts the same containers once however many requests arrive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workload } from './store.js';

const rows = vi.hoisted(() => ({
  byId: new Map<string, Workload>(),
  composeCalls: [] as string[][],
  failStart: false,
  duringStop: null as null | (() => void),
  told: [] as string[],
}));
vi.mock('./store.js', async (orig) => ({
  ...(await orig<typeof import('./store.js')>()),
  listWorkloads: async () => [...rows.byId.values()],
  getWorkload: async (id: string) => rows.byId.get(id) ?? null,
  updateWorkload: async (id: string, patch: Partial<Workload>) => {
    const w = { ...rows.byId.get(id)!, ...patch };
    rows.byId.set(id, w);
    return w;
  },
}));
vi.mock('./docker.js', async (orig) => ({
  ...(await orig<typeof import('./docker.js')>()),
  compose: async (_w: Workload, args: string[]) => {
    rows.composeCalls.push(args);
    await new Promise((r) => setTimeout(r, 5));
    if (args[0] === 'stop') rows.duringStop?.();
    if (args[0] === 'start' && rows.failStart) throw new Error('no space left on device');
    return '';
  },
}));
vi.mock('../../audit.js', () => ({ audit: () => undefined }));
vi.mock('./notify.js', () => ({
  notifyWorkloadAgent: async (_g: string, text: string) => void rows.told.push(text),
}));

const {
  __resetSleepForTest,
  defaultSleepH,
  isWaking,
  registerDeployBusy,
  sleepDue,
  sleepSweep,
  wakeOnUse,
  wakeWorkload,
  WAKE_RETRY_MS,
} = await import('./sleep.js');

const H = 3_600_000;
const NOW = 1_000 * H;
const wl = (id: string, patch: Partial<Workload> = {}): Workload =>
  ({
    id,
    name: id,
    agentGroupId: 'ag',
    state: 'running',
    sleepAfterH: null,
    asleepAt: null,
    updatedAt: 0,
    ...patch,
  }) as Workload;

beforeEach(() => {
  rows.byId.clear();
  rows.composeCalls.length = 0;
  rows.failStart = false;
  rows.duringStop = null;
  rows.told.length = 0;
  __resetSleepForTest();
});

describe('sleepDue', () => {
  it('after the default idle time, counting the last request and the last deploy', () => {
    const w = wl('a');
    expect(sleepDue(w, NOW, NOW - defaultSleepH() * H)).toBe(true);
    expect(sleepDue(w, NOW, NOW - defaultSleepH() * H + 1)).toBe(false);
    expect(sleepDue({ ...w, updatedAt: NOW - H }, NOW, 0)).toBe(false);
  });

  it('honours a stack setting: its own hours, or never', () => {
    expect(sleepDue(wl('a', { sleepAfterH: 2 }), NOW, NOW - 2 * H)).toBe(true);
    expect(sleepDue(wl('a', { sleepAfterH: 0 }), NOW, 0)).toBe(false);
  });

  it('only running stacks sleep', () => {
    expect(sleepDue(wl('a', { state: 'stopped' }), NOW, 0)).toBe(false);
  });
});

describe('sleep and wake', () => {
  it('the sweep stops idle stacks and marks them asleep', async () => {
    rows.byId.set('idle', wl('idle'));
    rows.byId.set('busy', wl('busy'));
    rows.byId.set('always', wl('always', { sleepAfterH: 0 }));
    const slept = await sleepSweep(NOW, (id) => (id === 'busy' ? NOW - H : 0));
    expect(slept).toEqual(['idle']);
    expect(rows.byId.get('idle')).toMatchObject({ state: 'stopped', asleepAt: NOW });
    expect(rows.composeCalls).toEqual([['stop']]);
  });

  it('a wake starts the containers once, however many requests arrive', async () => {
    rows.byId.set('a', wl('a', { state: 'stopped', asleepAt: NOW }));
    const p = Promise.all([wakeWorkload('a'), wakeWorkload('a'), wakeWorkload('a')]);
    expect(isWaking('a')).toBe(true);
    await p;
    expect(isWaking('a')).toBe(false);
    expect(rows.composeCalls).toEqual([['start']]);
    expect(rows.byId.get('a')).toMatchObject({ state: 'running', asleepAt: null });
  });

  it('a stack stopped on purpose does not wake', async () => {
    rows.byId.set('a', wl('a', { state: 'stopped', asleepAt: null }));
    await wakeWorkload('a');
    expect(rows.composeCalls).toEqual([]);
  });

  it('reads each stack again before stopping it: one that changed since the list stays up', async () => {
    rows.byId.set('a', wl('a'));
    rows.byId.set('b', wl('b'));
    registerDeployBusy((id) => id === 'b');
    const list = [...rows.byId.values()];
    rows.byId.set('a', wl('a', { state: 'deploying' }));
    const slept = await sleepSweep(NOW, () => 0);
    expect(slept).toEqual([]);
    expect(rows.composeCalls).toEqual([]);
    expect(list).toHaveLength(2);
  });

  it('never overwrites what happened during the stop (a redeploy wins)', async () => {
    rows.byId.set('a', wl('a'));
    rows.duringStop = () => rows.byId.set('a', wl('a', { state: 'deploying', updatedAt: NOW }));
    expect(await sleepSweep(NOW, () => 0)).toEqual([]);
    expect(rows.byId.get('a')).toMatchObject({ state: 'deploying', asleepAt: null });
  });

  it('a failed wake is recorded, the agent told, and visitors answered for a while instead of retried', async () => {
    rows.byId.set('a', wl('a', { state: 'stopped', asleepAt: NOW }));
    rows.failStart = true;
    expect(await wakeOnUse('a', NOW)).toBe('starting');
    await wakeWorkload('a');
    expect(rows.byId.get('a')).toMatchObject({ state: 'stopped', lastError: expect.stringMatching(/did not wake/) });
    expect(rows.told[0]).toMatch(/did not start again/);
    const starts = rows.composeCalls.length;
    expect(await wakeOnUse('a', Date.now())).toBe('failed');
    expect(rows.composeCalls).toHaveLength(starts);
    rows.failStart = false;
    expect(await wakeOnUse('a', Date.now() + WAKE_RETRY_MS + 1)).toBe('starting');
  });

  it('a running stack is just counted', async () => {
    rows.byId.set('a', wl('a'));
    expect(await wakeOnUse('a', NOW)).toBe('running');
    expect(rows.composeCalls).toEqual([]);
  });
});
