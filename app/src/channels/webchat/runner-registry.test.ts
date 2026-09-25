import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import {
  PlacementError,
  approveMachine,
  deletePlacement,
  getMachine,
  getPlacement,
  listMachines,
  listPlacements,
  recordMachineSeen,
  revokeMachine,
  setMachineApprovalId,
  setPlacement,
  placementSlots,
  DEFAULT_RUNNER_SLOTS,
  WORKSPACE_SLOT,
} from './runner-registry.js';

const seen = (fp: string, userId = 'webchat:jane') => ({
  fingerprint: fp,
  userId,
  hostname: 'W1',
  os: 'win32',
  arch: 'x64',
  runnerVersion: 'vscode-0.1.2',
});

describe('runner registry', () => {
  beforeEach(async () => {
    await initTestDb();
    await runMigrations(getDb());
  });
  afterEach(async () => {
    await closeDb();
  });

  it('first hello creates a pending machine bound to the user; later hellos refresh, never re-bind', async () => {
    const a = await recordMachineSeen(seen('fp1'), 1000);
    expect(a.status).toBe('pending');
    expect(a.user_id).toBe('webchat:jane');
    const b = await recordMachineSeen({ ...seen('fp1'), hostname: 'W1-renamed' }, 2000);
    expect(b.hostname).toBe('W1-renamed');
    expect(b.first_seen).toBe(1000);
    expect(b.last_seen).toBe(2000);
    const other = await recordMachineSeen(seen('fp1', 'webchat:mallory'), 3000);
    expect(other.user_id).toBe('webchat:jane'); // untouched: caller refuses on the mismatch
    expect((await getMachine('fp1'))?.hostname).toBe('W1-renamed');
  });

  it('approve / revoke round-trip and revoke drops placements', async () => {
    await recordMachineSeen(seen('fp1'));
    await setMachineApprovalId('fp1', 'appr-1');
    expect((await getMachine('fp1'))?.approval_id).toBe('appr-1');
    const ok = await approveMachine('fp1', 'webchat:owner', 5000);
    expect(ok?.status).toBe('approved');
    expect(ok?.approved_by).toBe('webchat:owner');
    expect(ok?.approval_id).toBeNull();
    await setPlacement('ag-1', 'fp1', 'webchat:owner');
    expect((await getPlacement('ag-1'))?.fingerprint).toBe('fp1');
    const rev = await revokeMachine('fp1', 'webchat:owner', 6000);
    expect(rev?.status).toBe('revoked');
    expect(await listPlacements()).toEqual([]);
  });

  it('placements require an approved machine', async () => {
    await expect(setPlacement('ag-1', 'nope', 'webchat:owner')).rejects.toBeInstanceOf(PlacementError);
    await recordMachineSeen(seen('fp1'));
    await expect(setPlacement('ag-1', 'fp1', 'webchat:owner')).rejects.toMatchObject({ code: 'machine-not-approved' });
    await approveMachine('fp1', 'webchat:owner');
    const p = await setPlacement('ag-1', 'fp1', 'webchat:owner', { project: '/slot' });
    expect(JSON.parse(p.slots_json)).toEqual({ project: '/slot' });
    expect(await deletePlacement('ag-1')).toBe(true);
    expect(await deletePlacement('ag-1')).toBe(false);
    expect((await listMachines()).map((m) => m.fingerprint)).toEqual(['fp1']);
  });
});

describe('declared slots', () => {
  it('parses both shapes, ignores junk, and defaults to the developer workspace', () => {
    expect(
      placementSlots({
        slots_json:
          '{"/workspace/project":{"mode":"rw","propose":true},"/data":{"mode":"ro","exclude":["*.tfvars"," ",5],"propose":"yes"}}',
      }),
    ).toEqual({
      '/workspace/project': { mode: 'rw', propose: true },
      '/data': { mode: 'ro', exclude: ['*.tfvars'] },
    });
    expect(placementSlots({ slots_json: '{"relative":"rw","/x/../y":"rw","/ok":"rwx","/n":5}' })).toEqual({});
    expect(placementSlots({ slots_json: 'not json' })).toEqual({});
    expect(placementSlots(undefined)).toEqual({});
    expect(DEFAULT_RUNNER_SLOTS).toEqual({ [WORKSPACE_SLOT]: { mode: 'rw', propose: true } });
  });
});
