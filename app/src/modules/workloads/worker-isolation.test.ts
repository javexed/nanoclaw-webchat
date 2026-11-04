/**
 * Central's half of a worker's isolation check: ask for one when the result
 * is missing or old (not on every sweep), and when a worker reports that the
 * check got through, record its stacks as stopped and tell their agents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../audit.js', () => ({ audit: () => undefined }));

import type { Member } from '../machines/members.js';
import type { Workload } from './store.js';
import {
  __resetWorkerIsolationForTest,
  ASK_EVERY_MS,
  reconcileWorkerIsolation,
  STOPPED_OPEN,
  type WorkerIsolationDeps,
} from './worker-isolation.js';

const NOW = 1_800_000_000_000;

const member = (id: string, over: Partial<Member> = {}): Member =>
  ({
    id,
    name: id.toUpperCase(),
    role: 'worker',
    state: 'ready',
    workloadsOn: true,
    isolation: 'ok',
    isolationAt: NOW - 60_000,
    ...over,
  }) as Member;

const wl = (id: string, node: string, state: Workload['state'] = 'running'): Workload =>
  ({ id, name: id, agentGroupId: `ag-${id}`, node, state }) as Workload;

let log: string[];
function deps(members: Member[], workloads: Workload[] = [], unlinked: string[] = []): WorkerIsolationDeps {
  return {
    members: async () => members,
    linked: (id) => !unlinked.includes(id),
    ask: async (id) => void log.push(`ask ${id}`),
    workloads: async () => workloads,
    stopped: async (w) => void log.push(`stopped ${w.id}`),
    notify: async (g, text) => void log.push(`notify ${g} ${text}`),
  };
}

beforeEach(() => {
  log = [];
  __resetWorkerIsolationForTest();
});

describe('worker isolation, from central', () => {
  it('asks a linked worker without a recent result, at most every ten minutes', async () => {
    const d = deps(
      [
        member('m-ok'),
        member('m-new', { isolation: null, isolationAt: null }),
        member('m-old', { isolationAt: NOW - 2 * 3_600_000 }),
        member('m-gone', { isolation: null, isolationAt: null }),
        member('m-revoked', { state: 'revoked', isolation: null }),
      ],
      [],
      ['m-gone'],
    );
    await reconcileWorkerIsolation(NOW, d);
    expect(log).toEqual(['ask m-new', 'ask m-old']);
    await reconcileWorkerIsolation(NOW + 60_000, d);
    expect(log).toHaveLength(2);
    await reconcileWorkerIsolation(NOW + ASK_EVERY_MS, d);
    expect(log).toEqual(['ask m-new', 'ask m-old', 'ask m-new', 'ask m-old']);
  });

  it("records a worker's running stacks as stopped when its check got through, and tells their agents", async () => {
    const d = deps(
      [member('m-open', { isolation: 'open' }), member('m-ok')],
      [
        wl('a', 'm-open'),
        wl('b', 'm-open', 'deploying'),
        wl('c', 'm-open', 'stopped'),
        wl('d', 'm-ok'),
        wl('e', 'local'),
      ],
    );
    await reconcileWorkerIsolation(NOW, d);
    expect(log.filter((l) => l.startsWith('stopped'))).toEqual(['stopped a', 'stopped b']);
    const notes = log.filter((l) => l.startsWith('notify'));
    expect(notes.map((l) => l.split(' ')[1])).toEqual(['ag-a', 'ag-b']);
    expect(notes[0]).toContain('"a" was stopped: its worker M-OPEN failed the isolation check');
    expect(STOPPED_OPEN).toMatch(/host rules missing/);
  });
});
