import { describe, expect, it, vi } from 'vitest';

const startMcpRelay = vi.hoisted(() => vi.fn());
vi.mock('../channels/webchat/mcp-relay.js', () => ({ startMcpRelay }));

import { FleetSessionDriver } from './fleet-driver.js';
import { fakeLocalDriver } from './fleet-fixture.js';
import { getSessionDriverFactory } from './driver-registry.js';
import type { SessionSpec } from './types.js';

const spec = (agentGroupId: string): SessionSpec =>
  ({ key: { installSlug: 'i', agentGroupId, sessionId: 's' } }) as unknown as SessionSpec;
const placed = async (id: string) => ({
  agent_group_id: id,
  fingerprint: 'f'.repeat(64),
  slots_json: '{}',
  created_by: 'o',
  created_at: 1,
  mode: 'tools' as const,
  tools_token: 't',
});

describe('FleetSessionDriver', () => {
  it('delegates everything to the local driver and reports the local capabilities', async () => {
    const local = fakeLocalDriver();
    const fleet = new FleetSessionDriver(local, async () => undefined);
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
    expect(startMcpRelay).not.toHaveBeenCalled();
  });

  it('a group placed on a machine runs here, on central, with the relay to its laptop tools up', async () => {
    const local = fakeLocalDriver();
    const fleet = new FleetSessionDriver(local, placed);
    await fleet.prepare(spec('ag-tools'));
    expect(local.calls).toContain('prepare:ag-tools');
    expect(startMcpRelay).toHaveBeenCalled();
  });

  it('a failing placement lookup never blocks a session', async () => {
    const local = fakeLocalDriver();
    const failing = new FleetSessionDriver(local, async () => {
      throw new Error('db down');
    });
    await failing.prepare(spec('ag-x'));
    expect(local.calls).toEqual(['prepare:ag-x']);
  });

  it('registers itself as kind fleet via the barrel', () => {
    expect(getSessionDriverFactory('fleet')).toBeTypeOf('function');
  });
});
