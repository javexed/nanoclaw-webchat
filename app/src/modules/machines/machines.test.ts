import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nfs = require('fs') as typeof fs,
    npath = require('path') as typeof path,
    nos = require('os') as typeof os;
  return { ROOT: nfs.mkdtempSync(npath.join(nos.tmpdir(), 'machines-')) };
});
const notices: Array<{ group: string; text: string }> = [];
const audits: Array<{ type: string; effect?: string }> = [];

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  DATA_DIR: path.join(ROOT, 'data'),
  GROUPS_DIR: path.join(ROOT, 'groups'),
  INSTALL_SLUG: 'test-install',
}));
vi.mock('../../db/agent-groups.js', async (orig) => ({
  ...(await orig<object>()),
  getAgentGroup: async (id: string) => ({ id, folder: id, name: id }),
  getAllAgentGroups: async () => [],
}));
// No network in tests: no host-key scan, no vault, no session mailboxes.
vi.mock('../deploy-keys/ssh-config.js', async (orig) => ({ ...(await orig<object>()), syncSshConfig: async () => {} }));
vi.mock('../tool-secrets/index.js', () => ({ refreshCredentialNote: async () => {} }));
vi.mock('../deploy-keys/notify.js', async (orig) => ({
  ...(await orig<object>()),
  notifyKeyChange: async (group: string, text: string) => {
    notices.push({ group, text });
    return 1;
  },
}));
vi.mock('../../audit.js', () => ({ audit: (e: { type: string; effect?: string }) => audits.push(e) }));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getResource } from '../../cli/crud.js';
import { listDeployKeys } from '../deploy-keys/index.js';
import { checkCreate, createMachine, deleteMachine, startMachine, stopMachine } from './control.js';
import './cli.js';
import { __resetReconcileForTest, reconcileAll } from './reconcile.js';
import { getMachine, listMachines, putSite, updateMachine } from './store.js';
import type { Site } from './types.js';

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const site = (over: Partial<Site> = {}): Site => ({
  id: 'lab',
  backend: 'fake',
  label: 'Lab',
  config: {},
  sizes: { small: { vcpu: 2, memoryGb: 8, backendSize: 's' }, large: { vcpu: 4, memoryGb: 16, backendSize: 'l' } },
  perAgentCap: 2,
  installCap: 3,
  autoStopAt: null,
  enabled: true,
  ...over,
});
const fakeFile = (id = 'lab') => path.join(ROOT, 'data', 'machines', `fake-${id}.json`);
const editFake = (fn: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) =>
  fs.writeFileSync(fakeFile(), JSON.stringify(fn(JSON.parse(fs.readFileSync(fakeFile(), 'utf8')))));

beforeEach(async () => {
  await closeDb().catch(() => undefined);
  await initTestDb();
  await runMigrations(getDb());
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
  for (const g of ['ag-a', 'ag-b']) {
    fs.rmSync(path.join(ROOT, 'groups', g), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, 'groups', g), { recursive: true });
  }
  notices.length = 0;
  audits.length = 0;
  __resetReconcileForTest();
  await putSite(site());
});

describe('machine rules', () => {
  it('refuses bad names, unknown sizes, duplicates and anything over a cap', async () => {
    await expect(checkCreate('ag-a', { name: 'Bad Name', size: 'small' })).rejects.toThrow(/lowercase/);
    await expect(checkCreate('ag-a', { name: 'web', size: 'huge' })).rejects.toThrow(/no size "huge"/);
    await createMachine('ag-a', { name: 'web', size: 'small' }, null);
    await expect(checkCreate('ag-a', { name: 'web', size: 'small' })).rejects.toThrow(/already have/);
    await createMachine('ag-a', { name: 'db', size: 'small' }, null);
    await expect(checkCreate('ag-a', { name: 'three', size: 'small' })).rejects.toThrow(/limit per agent is 2/);
    await createMachine('ag-b', { name: 'one', size: 'small' }, null);
    await expect(checkCreate('ag-b', { name: 'two', size: 'small' })).rejects.toThrow(/at its limit of 3/);
  });

  it('needs --site when more than one site is enabled', async () => {
    await putSite(site({ id: 'other' }));
    await expect(checkCreate('ag-a', { name: 'web', size: 'small' })).rejects.toThrow(/pass --site/);
    expect((await checkCreate('ag-a', { name: 'web', size: 'small', site: 'other' })).site.id).toBe('other');
  });
});

describe('machine lifecycle on the fake backend', () => {
  it('provisions, becomes reachable as ssh machine-<name>, stops, starts and deletes', async () => {
    const m = await createMachine('ag-a', { name: 'web', size: 'small' }, 'agent:ag-a');
    expect(m.state).toBe('provisioning');
    expect(m.handle).toBeTruthy();
    expect((await listDeployKeys('ag-a')).map((k) => k.name)).toEqual(['machine-web']);

    await reconcileAll();
    const up = (await getMachine(m.id))!;
    expect(up.state).toBe('running');
    expect(up.privateIp).toMatch(/^10\.99\./);
    const key = (await listDeployKeys('ag-a')).find((k) => k.name === 'machine-web')!;
    expect(key.target).toBe(`nanoclaw@${up.privateIp}`);
    expect(notices.at(-1)?.text).toContain('ssh machine-web');

    expect((await stopMachine('ag-a', 'web')).state).toBe('stopped');
    expect((await startMachine('ag-a', 'web')).state).toBe('running');
    const gone = await deleteMachine('ag-a', 'web');
    expect(gone.state).toBe('deleted');
    expect(await listDeployKeys('ag-a')).toEqual([]);
    expect(audits.map((a) => a.type)).toEqual(
      expect.arrayContaining(['machine.create', 'machine.ready', 'machine.stop', 'machine.start', 'machine.delete']),
    );
  });

  it('an agent cannot touch another agent’s machine', async () => {
    await createMachine('ag-a', { name: 'web', size: 'small' }, null);
    await expect(stopMachine('ag-b', 'web')).rejects.toThrow(/no machine named "web"/);
    await expect(deleteMachine('ag-b', 'web')).rejects.toThrow(/no machine named "web"/);
  });
});

describe('reconciliation', () => {
  it('follows drift, notices a vanished machine, and reports orphans', async () => {
    const m = await createMachine('ag-a', { name: 'web', size: 'small' }, null);
    await reconcileAll();
    // Stopped in a portal: the record follows.
    editFake((rows) => rows.map((r) => ({ ...r, state: 'stopped' })));
    __resetReconcileForTest();
    await reconcileAll();
    expect((await getMachine(m.id))!.state).toBe('stopped');
    // A machine NanoClaw never made, tagged with this install.
    editFake((rows) => [
      ...rows,
      {
        handle: 'stray',
        opId: 'x',
        state: 'running',
        privateIp: '10.0.9.9',
        sizeName: 'small',
        tags: { 'nanoclaw-install': 'test-install' },
      },
    ]);
    // Deleted out of band.
    editFake((rows) => rows.filter((r) => r.handle !== m.handle));
    __resetReconcileForTest();
    await reconcileAll();
    expect((await getMachine(m.id))!.state).toBe('deleted');
    expect(audits.map((a) => a.type)).toEqual(expect.arrayContaining(['machine.gone', 'machine.orphan']));
    expect(await listMachines({ agentGroupId: 'ag-a' })).toEqual([]);
  });

  it('stops a machine past its expiry and tells its agent', async () => {
    const m = await createMachine('ag-a', { name: 'web', size: 'small' }, null);
    await reconcileAll();
    await updateMachine(m.id, { expiresAt: Date.now() - 1000 });
    __resetReconcileForTest();
    await reconcileAll();
    expect((await getMachine(m.id))!.state).toBe('stopped');
    expect(audits.some((a) => a.type === 'machine.autostop')).toBe(true);
    expect(notices.at(-1)?.text).toContain('passed its expiry date');
  });
});

describe('ncl machines', () => {
  const ops = () => getResource('machines')!.customOperations!;
  const agentA = { caller: 'agent' as const, agentGroupId: 'ag-a', sessionId: 's', messagingGroupId: 'm' };

  it('holds create, resize and delete for approval and keeps the rest open', () => {
    expect(ops().create.access).toBe('approval');
    expect(ops().resize.access).toBe('approval');
    expect(ops().delete.access).toBe('approval');
    expect([ops().list.access, ops().start.access, ops().stop.access]).toEqual(['open', 'open', 'open']);
    expect(ops()['site-set'].hostOnly).toBe(true);
  });

  it("scopes to the caller's own group, whatever --group says", async () => {
    await createMachine('ag-b', { name: 'secret', size: 'small' }, null);
    const rows = (await ops().list.handler({ group: 'ag-b' }, agentA)) as unknown[];
    expect(rows).toEqual([]);
  });
});
