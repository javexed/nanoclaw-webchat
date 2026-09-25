import { describe, expect, it, vi } from 'vitest';

import { FleetSessionDriver } from './fleet-driver.js';
import { fakeLocalDriver } from './fleet-fixture.js';
import { getSessionDriverFactory } from './driver-registry.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import type { SessionSpec } from './types.js';

// The fixture's mounts live under group g1; a valid spec for any other group id
// would need its own mount sources, so the placed case uses g1 as-is.
const spec = (agentGroupId: string): SessionSpec =>
  agentGroupId === 'g1'
    ? fixtureSpec()
    : ({ key: { installSlug: 'i', agentGroupId, sessionId: 's' } } as unknown as SessionSpec);

describe('FleetSessionDriver: decision without transport', () => {
  it('delegates everything to the local driver and reports the local capabilities', async () => {
    const local = fakeLocalDriver();
    const fleet = new FleetSessionDriver(local, async () => undefined, FIXTURE_POLICY);
    expect(fleet.kind).toBe('fleet');
    expect(fleet.capabilities().admissionEnforced).toBe(true);
    await fleet.ensureReady();
    await fleet.prepare(spec('ag-local'));
    await fleet.listSessions('i');
    fleet.watchSessions('i', () => {});
    await fleet.reapResidue('i');
    expect(local.calls).toEqual([
      'capabilities',
      'ensureReady',
      'prepare:ag-local',
      'listSessions',
      'watchSessions',
      'reapResidue',
    ]);
  });
  it('a failing placement lookup never blocks a session (runs locally)', async () => {
    const local = fakeLocalDriver();
    const lookup = vi.fn(async (id: string) =>
      id === 'g1'
        ? { agent_group_id: id, fingerprint: 'f'.repeat(64), slots_json: '{}', created_by: 'o', created_at: 1 }
        : undefined,
    );
    // A port with no runner connected: the placed group cannot run anywhere, so prepare fails retryable.
    const offline = {
      request: async () => {
        throw new Error('unused');
      },
      isConnected: () => false,
      connected: () => [],
      onEvent: () => () => {},
      onHeartbeat: () => () => {},
      authorize: async () => ({ ok: true }) as const,
      imageSource: async () => ({ policy: 'machine' as const }),
      roots: { dataRoot: '/install/data', groupsRoot: '/install/groups', buildContext: '/install/container' },
      touchHeartbeat: () => {},
    };
    const fleet = new FleetSessionDriver(local, lookup, FIXTURE_POLICY, offline);
    await expect(fleet.prepare(spec('g1'))).rejects.toMatchObject({ kind: 'runtime-unavailable' }); // placed, runner not connected
    const failing = new FleetSessionDriver(
      local,
      async () => {
        throw new Error('db down');
      },
      FIXTURE_POLICY,
    );
    await failing.prepare(spec('ag-x'));
    expect(local.calls.filter((c) => c.startsWith('prepare:'))).toEqual(['prepare:ag-x']);
    expect(lookup).toHaveBeenCalledWith('g1');
  });
  it('registers itself as kind fleet via the barrel', () => {
    expect(getSessionDriverFactory('fleet')).toBeTypeOf('function');
  });
});
