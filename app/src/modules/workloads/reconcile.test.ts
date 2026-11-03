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
import {
  EXPIRY_NOTICE_MS,
  reconcileWorkloads,
  __resetWorkloadReconcileForTest,
  type ReconcileDeps,
} from './reconcile.js';
import { DEFAULT_DAYS, extendWorkload } from './control.js';
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
  notify: async (g, text) => void log.push(`notify ${g} ${text}`),
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

  it('reminds the agent once, a few days before a stack expires; extending re-arms it', async () => {
    const DAY = 86_400_000;
    const t0 = Date.UTC(2026, 10, 28, 12);
    const w = await running('ag-1', 'notes', t0 + 2 * DAY);
    await reconcileWorkloads(t0, deps);
    const notices = () => log.filter((l) => l.includes('expires on'));
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain('Your workload "notes" expires on 30 Nov');
    expect(notices()[0]).toContain('Agent → Apps');
    // Two minutes later, and after a restart (the reminder is kept in the database): not again.
    __resetWorkloadReconcileForTest();
    await reconcileWorkloads(t0 + 3 * 60_000, deps);
    expect(notices()).toHaveLength(1);
    // Extended: 30 days from now, and reminded again only near the new date.
    const ext = await extendWorkload('ag-1', 'notes', 'human:webchat:admin', t0);
    expect(ext.expiresAt).toBe(t0 + DEFAULT_DAYS * DAY);
    __resetWorkloadReconcileForTest();
    await reconcileWorkloads(t0 + 6 * 60_000, deps);
    expect(notices()).toHaveLength(1);
    __resetWorkloadReconcileForTest();
    await reconcileWorkloads(ext.expiresAt! - EXPIRY_NOTICE_MS + 1, deps);
    expect(notices()).toHaveLength(2);
    expect((await listWorkloads()).find((x) => x.id === w.id)?.expiryNoticeFor).toBe(ext.expiresAt);
  });

  it('the expiry notice points to Agent → Apps and to extend', async () => {
    await running('ag-1', 'old', 1000);
    await reconcileWorkloads(5000, deps);
    const n = log.find((l) => l.includes('passed its expiry'))!;
    expect(n).toContain('Agent → Apps');
    expect(n).toContain('ncl workloads extend --name old');
  });
});

describe('extending a workload', () => {
  const DAY = 86_400_000;
  it('makes it 30 days from now, never shorter, never stacked', async () => {
    const now = Date.UTC(2026, 10, 2);
    await running('ag-1', 'notes', now + 5 * DAY);
    expect((await extendWorkload('ag-1', 'notes', 'host', now)).expiresAt).toBe(now + 30 * DAY);
    // Again the same day: still 30 days from now, not 60.
    expect((await extendWorkload('ag-1', 'notes', 'host', now)).expiresAt).toBe(now + 30 * DAY);
    // A later expiry is kept.
    await running('ag-1', 'long', now + 90 * DAY);
    expect((await extendWorkload('ag-1', 'long', 'host', now)).expiresAt).toBe(now + 90 * DAY);
    // No expiry stays none; an expired one comes back for 30 days.
    await running('ag-1', 'forever', null);
    expect((await extendWorkload('ag-1', 'forever', 'host', now)).expiresAt).toBeNull();
    await running('ag-1', 'old', now - DAY);
    expect((await extendWorkload('ag-1', 'old', 'host', now)).expiresAt).toBe(now + 30 * DAY);
    await expect(extendWorkload('ag-2', 'notes', 'host', now)).rejects.toThrow(/no workload named/);
  });
});
