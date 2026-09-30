import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import {
  PlacementError,
  approveMachine,
  bindMachineKey,
  deletePlacement,
  getMachine,
  getPlacement,
  getPlacementByToolsToken,
  listMachines,
  listPlacements,
  recordMachineSeen,
  revokeMachine,
  setMachineApprovalId,
  setPlacement,
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
    const p = await setPlacement('ag-1', 'fp1', 'webchat:owner');
    expect(p).toMatchObject({ agent_group_id: 'ag-1', fingerprint: 'fp1', mode: 'tools', slots_json: '{}' });
    expect(await deletePlacement('ag-1')).toBe(true);
    expect(await deletePlacement('ag-1')).toBe(false);
    expect((await listMachines()).map((m) => m.fingerprint)).toEqual(['fp1']);
  });

  it('a key is recorded at first sight, bound once, never replaced, and cleared by a revoke', async () => {
    expect((await recordMachineSeen({ ...seen('fp1'), publicKey: 'K1' })).public_key).toBe('K1');
    // A later hello does not touch it; binding over it is refused.
    expect((await recordMachineSeen({ ...seen('fp1'), publicKey: 'K2' })).public_key).toBe('K1');
    expect(await bindMachineKey('fp1', 'K2')).toBe(false);
    await approveMachine('fp1', 'webchat:owner');
    expect((await revokeMachine('fp1', 'webchat:owner'))?.public_key).toBeNull();
    // Re-approval: the next connection binds again.
    await approveMachine('fp1', 'webchat:owner');
    expect(await bindMachineKey('fp1', 'K3')).toBe(true);
    expect((await getMachine('fp1'))?.public_key).toBe('K3');
    // A machine seen without a key stays unbound until it proves one.
    expect((await recordMachineSeen(seen('fp2'))).public_key).toBeNull();
  });

  it('keyless entry ends for good once a key is bound or the machine is revoked', async () => {
    const legacy = async (fp: string) => {
      await recordMachineSeen(seen(fp));
      await getDb().run(`UPDATE webchat_runner_machines SET keyless_allowed = 1 WHERE fingerprint = ?`, fp);
    };
    await legacy('fp-bind');
    await bindMachineKey('fp-bind', 'K1');
    expect((await getMachine('fp-bind'))?.keyless_allowed).toBe(0);
    await legacy('fp-rev');
    await revokeMachine('fp-rev', 'webchat:owner');
    await approveMachine('fp-rev', 'webchat:owner');
    expect(await getMachine('fp-rev')).toMatchObject({ status: 'approved', public_key: null, keyless_allowed: 0 });
    // A machine recorded now is never keyless.
    await recordMachineSeen({ ...seen('fp-new'), publicKey: 'K9' });
    expect((await getMachine('fp-new'))?.keyless_allowed).toBe(0);
  });

  it('a placement is always a tools placement, with a token it keeps across updates', async () => {
    await recordMachineSeen(seen('fp1'));
    await approveMachine('fp1', 'webchat:owner');
    const tools = await setPlacement('ag-1', 'fp1', 'webchat:owner', 1000);
    expect(tools.mode).toBe('tools');
    expect(tools.tools_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await setPlacement('ag-1', 'fp1', 'webchat:owner', 2000)).tools_token).toBe(tools.tools_token);
    expect((await getPlacementByToolsToken(tools.tools_token!))?.agent_group_id).toBe('ag-1');
    await deletePlacement('ag-1');
    expect(await getPlacementByToolsToken(tools.tools_token!)).toBeUndefined();
  });
});
