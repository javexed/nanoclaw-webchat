/**
 * Idle stacks sleep and wake: who is due, the sweep stops and marks them,
 * a wake starts the same containers once however many requests arrive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workload } from './store.js';

const rows = vi.hoisted(() => ({ byId: new Map<string, Workload>(), composeCalls: [] as string[][] }));
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
    return '';
  },
}));
vi.mock('../../audit.js', () => ({ audit: () => undefined }));

const { DEFAULT_SLEEP_H, isWaking, sleepDue, sleepSweep, wakeWorkload } = await import('./sleep.js');

const H = 3_600_000;
const NOW = 1_000 * H;
const wl = (id: string, patch: Partial<Workload> = {}): Workload =>
  ({ id, name: id, agentGroupId: 'ag', state: 'running', sleepAfterH: null, asleepAt: null, updatedAt: 0, ...patch }) as Workload;

beforeEach(() => {
  rows.byId.clear();
  rows.composeCalls.length = 0;
});

describe('sleepDue', () => {
  it('after the default idle time, counting the last request and the last deploy', () => {
    const w = wl('a');
    expect(sleepDue(w, NOW, NOW - DEFAULT_SLEEP_H * H)).toBe(true);
    expect(sleepDue(w, NOW, NOW - DEFAULT_SLEEP_H * H + 1)).toBe(false);
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
});
