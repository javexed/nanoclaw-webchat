import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getAgentGroup } from '../../db/agent-groups.js';

import { completeApproval, ensureDedicatedGroup, runnerAutoGroupEnabled } from './runner-pairing.js';
import {
  deletePlacement,
  getMachine,
  getPlacement,
  listPlacements,
  recordMachineSeen,
  revokeMachine,
} from './runner-registry.js';

vi.mock('./state.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  broadcastRooms: vi.fn(async () => {}),
}));

const seen = {
  fingerprint: 'f'.repeat(64),
  userId: 'webchat:dev@example.com',
  hostname: 'DEVBOX01',
  os: 'win32',
  arch: 'x64',
  runnerVersion: 'vscode-0.1.3',
};

describe('completeApproval', () => {
  beforeEach(async () => {
    await initTestDb();
    await runMigrations(getDb());
    delete process.env.WEBCHAT_RUNNER_AUTO_GROUP;
  });
  afterEach(async () => {
    await closeDb();
  });

  it('is on by default and only "false" turns it off', () => {
    expect(runnerAutoGroupEnabled({})).toBe(true);
    expect(runnerAutoGroupEnabled({ WEBCHAT_RUNNER_AUTO_GROUP: 'false' })).toBe(false);
    expect(runnerAutoGroupEnabled({ WEBCHAT_RUNNER_AUTO_GROUP: 'no' })).toBe(true);
  });

  it('approving creates a dedicated agent group with a room and places it on the machine', async () => {
    await recordMachineSeen(seen);
    const out = await completeApproval(seen.fingerprint, 'webchat:owner');
    expect(out.machine?.status).toBe('approved');
    expect(out.groupCreated).toBe(true);
    expect(out.group?.folder).toBe('runner-devbox01-ffffffff');
    expect(out.group?.name).toBe('Runner · DEVBOX01');
    expect(out.placement?.fingerprint).toBe(seen.fingerprint);
    expect((await getPlacement(out.group!.id))?.created_by).toBe('webchat:owner');
    expect(await getAgentGroup(out.group!.id)).toBeDefined();
    // The dedicated agent must answer every message in its room, not only @-mentions.
    const wiring = (await getDb().get(
      `SELECT engage_pattern FROM messaging_group_agents WHERE agent_group_id = ?`,
      out.group!.id,
    )) as { engage_pattern: string };
    expect(wiring.engage_pattern).toBe('.');
  });

  it('a second approve adds nothing; after a revoke the same group is re-placed, not duplicated', async () => {
    await recordMachineSeen(seen);
    const first = await completeApproval(seen.fingerprint, 'webchat:owner');
    const again = await completeApproval(seen.fingerprint, 'webchat:owner');
    expect(again.groupCreated).toBeUndefined();
    expect(again.placement?.agent_group_id).toBe(first.group!.id);
    await revokeMachine(seen.fingerprint, 'webchat:owner');
    expect(await listPlacements()).toEqual([]);
    const third = await completeApproval(seen.fingerprint, 'webchat:owner');
    expect(third.groupCreated).toBe(false);
    expect(third.group?.id).toBe(first.group!.id);
    expect((await listPlacements()).length).toBe(1);
  });

  it('on reconnect, a placement an admin removed stays removed', async () => {
    await recordMachineSeen(seen);
    const first = await completeApproval(seen.fingerprint, 'webchat:owner');
    await deletePlacement(first.group!.id);
    const machine = (await getMachine(seen.fingerprint))!;
    const out = await ensureDedicatedGroup(machine, 'webchat:owner', { reconnect: true });
    expect(out.placement).toBeUndefined();
    expect(await listPlacements()).toEqual([]);
  });

  it('on reconnect, a machine that never got its group is provisioned', async () => {
    process.env.WEBCHAT_RUNNER_AUTO_GROUP = 'false';
    await recordMachineSeen(seen);
    await completeApproval(seen.fingerprint, 'webchat:owner'); // approved, no group
    delete process.env.WEBCHAT_RUNNER_AUTO_GROUP;
    const out = await ensureDedicatedGroup((await getMachine(seen.fingerprint))!, 'webchat:owner', { reconnect: true });
    expect(out.groupCreated).toBe(true);
    expect(out.placement?.fingerprint).toBe(seen.fingerprint);
  });

  it('with auto-group off, approve is just approve', async () => {
    process.env.WEBCHAT_RUNNER_AUTO_GROUP = 'false';
    await recordMachineSeen(seen);
    const out = await completeApproval(seen.fingerprint, 'webchat:owner');
    expect(out.machine?.status).toBe('approved');
    expect(out.group).toBeUndefined();
    expect(await listPlacements()).toEqual([]);
  });

  it("a second machine with the same hostname gets its own group, not the first one's", async () => {
    await recordMachineSeen(seen);
    const a = await completeApproval(seen.fingerprint, 'webchat:owner');
    const other = { ...seen, fingerprint: 'e'.repeat(64), userId: 'webchat:someone@example.com' };
    await recordMachineSeen(other);
    const b = await completeApproval(other.fingerprint, 'webchat:owner');
    expect(b.group?.id).toBeDefined();
    expect(b.group?.id).not.toBe(a.group?.id);
    expect(b.group?.folder).toBe('runner-devbox01-eeeeeeee');
    expect((await getPlacement(a.group!.id))?.fingerprint).toBe(seen.fingerprint);
    expect((await getPlacement(b.group!.id))?.fingerprint).toBe(other.fingerprint);
  });
});
