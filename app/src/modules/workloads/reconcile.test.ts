/**
 * The reconcile loop against a real database, with Docker stood in through
 * its deps: the preflight's verdict, expiry, vanished containers, network
 * joins and disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { CheckedStack } from './policy.js';
import { __setPreflightForTest, type PreflightResult } from './preflight.js';
import { reconcileWorkloads, __resetWorkloadReconcileForTest, type ReconcileDeps } from './reconcile.js';
import { __resetDiskForTest } from './disk.js';
import { claimNetwork, insertWorkload, listWorkloads, setQuota, updateWorkload } from './store.js';

const stack: CheckedStack = {
  compose: { services: { web: { image: 'nginx:1.27' } } },
  limits: { web: { memoryMb: 512, cpus: 0.5 } },
  total: { memoryMb: 512, cpus: 0.5 },
};

let log: string[];
let pre: PreflightResult;
let psOut: string;
let usage: number;

const deps: ReconcileDeps = {
  preflight: async () => (__setPreflightForTest(pre), pre),
  stop: async (g, name, reason) => {
    log.push(`stop ${g} ${name} ${reason}`);
    const w = (await listWorkloads({ agentGroupId: g })).find((x) => x.name === name)!;
    return updateWorkload(w.id, { state: 'stopped' });
  },
  notify: async (g, text) => void log.push(`notify ${g} ${text.slice(0, 40)}`),
  ps: async () => psOut,
  join: async (g, network) => (log.push(`join ${g} ${network}`), 0),
  measure: async (ws) => new Map(ws.map((w) => [w.id, usage])),
  backup: async () => null,
};

async function running(agentGroupId: string, name: string, expiresAt: number | null = null) {
  const w = await insertWorkload({
    agentGroupId,
    name,
    composeText: '',
    stack,
    addresses: {},
    expiresAt,
    createdBy: null,
    approvedShape: null,
  });
  return updateWorkload(w.id, { state: 'running' });
}

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  __resetWorkloadReconcileForTest();
  __resetDiskForTest();
  log = [];
  pre = { ok: true, reason: '', isolationOpen: false, at: 0 };
  psOut = '{"Service":"web","State":"running"}';
  usage = 0;
});
afterEach(async () => {
  __setPreflightForTest(null);
  await closeDb();
});

describe('reconciling workloads', () => {
  it('stops every running stack when a workload network can reach this host', async () => {
    await running('ag-1', 'notes');
    await running('ag-2', 'shop');
    pre = { ok: false, reason: 'rules missing', isolationOpen: true, at: 0 };
    await reconcileWorkloads(1, deps);
    expect(log.filter((l) => l.startsWith('stop'))).toEqual([
      'stop ag-1 notes host isolation missing',
      'stop ag-2 shop host isolation missing',
    ]);
  });

  it('leaves stacks alone when the preflight merely could not run', async () => {
    await running('ag-1', 'notes');
    pre = { ok: false, reason: 'could not run', isolationOpen: false, at: 0 };
    await reconcileWorkloads(1, deps);
    expect(log.filter((l) => l.startsWith('stop'))).toEqual([]);
  });

  it('stops an expired stack and tells its agent; marks one whose containers are gone as failed', async () => {
    await running('ag-1', 'old', 1000);
    const gone = await running('ag-1', 'gone');
    psOut = '';
    await reconcileWorkloads(5000, deps);
    expect(log).toContain('stop ag-1 old expired');
    expect(log.some((l) => l.startsWith('notify ag-1 [System] Your workload "old" passed'))).toBe(true);
    expect((await listWorkloads()).find((w) => w.id === gone.id)?.state).toBe('failed');
  });

  it('joins each agent’s containers to its own network', async () => {
    const net = await claimNetwork('ag-1', (i) => `net-${i}`, 10);
    await reconcileWorkloads(1, deps);
    expect(log).toContain(`join ag-1 ${net.network}`);
  });

  it('warns near the disk quota once, and stops the agent’s stacks over it', async () => {
    await running('ag-1', 'notes');
    await setQuota('ag-1', { memoryMb: 4096, cpus: 2, diskGb: 1 });
    usage = 0.95 * 1024 ** 3;
    await reconcileWorkloads(1, deps);
    expect(log.filter((l) => l.startsWith('notify'))).toHaveLength(1);
    usage = 1.5 * 1024 ** 3;
    await reconcileWorkloads(1 + 10 * 60_000, deps);
    expect(log).toContain('stop ag-1 notes disk quota');
  });
});
