/** A deploy cut off by a restart is recorded as it is, never left 'deploying' and never re-run on its own. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ getDb: () => ({}) }));
const { settleInterrupted } = await import('./reconcile.js');

const wl = (over: Record<string, unknown>) =>
  ({
    id: 'w1',
    name: 'web',
    agentGroupId: 'ag-1',
    node: 'm-1',
    state: 'deploying',
    updatedAt: 0,
    stack: { compose: { services: { web: {}, db: {} } } },
    ...over,
  }) as never;

const all = async () => [
  { service: 'web', state: 'running' },
  { service: 'db', state: 'running' },
];

describe('settleInterrupted', () => {
  it('marks a stack whose old containers all run as running, and tells the agent to redeploy', async () => {
    const update = vi.fn(async () => ({}));
    const tell = vi.fn(async (_a: string, _t: string) => undefined);
    await settleInterrupted({
      list: async () => [wl({}), wl({ id: 'w2', state: 'running' })],
      states: all,
      update: update as never,
      tell,
      linked: () => true,
      now: 120_000,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('w1', {
      state: 'running',
      lastError: 'its last deploy was cut off by a NanoClaw restart; the previous version is still running',
    });
    expect(tell.mock.calls[0]![1]).toMatch(/ncl workloads redeploy --name web/);
  });

  it('marks it failed when only part of the stack runs', async () => {
    const update = vi.fn(async () => ({}));
    await settleInterrupted({
      list: async () => [wl({})],
      states: async () => [
        { service: 'web', state: 'running' },
        { service: 'db', state: 'exited' },
      ],
      update: update as never,
      tell: async () => undefined,
      linked: () => true,
      now: 120_000,
    });
    expect(update).toHaveBeenCalledWith('w1', {
      state: 'failed',
      lastError: 'its last deploy was cut off by a NanoClaw restart',
    });
  });

  it('marks it failed when nothing runs, and waits for a worker link and a minute’s grace', async () => {
    const update = vi.fn(async () => ({}));
    const base = { states: async () => [], update: update as never, tell: async () => undefined };
    await settleInterrupted({ ...base, list: async () => [wl({})], linked: () => false, now: 120_000 });
    await settleInterrupted({
      ...base,
      list: async () => [wl({ updatedAt: 100_000 })],
      linked: () => true,
      now: 120_000,
    });
    expect(update).not.toHaveBeenCalled();
    await settleInterrupted({ ...base, list: async () => [wl({})], linked: () => true, now: 120_000 });
    expect(update).toHaveBeenCalledWith('w1', {
      state: 'failed',
      lastError: 'its last deploy was cut off by a NanoClaw restart',
    });
  });
});
