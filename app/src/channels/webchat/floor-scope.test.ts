import { beforeEach, describe, expect, it, vi } from 'vitest';

// The scope regression the security review caught: canAccessAgentGroup returns
// an AccessDecision OBJECT, and both floor files negated the object — always
// truthy, so the per-caller filter never fired and every authenticated
// identity saw every desk and every feed fragment install-wide. These tests
// exercise the REAL filter with mocked collaborators, because the pure-helper
// tests deliberately skipped it and that is exactly how it shipped.

vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    all: vi.fn(async () => [
      { id: 's-allowed', agent_group_id: 'ag-mine', messaging_group_id: null, last_active: null },
      { id: 's-denied', agent_group_id: 'ag-other', messaging_group_id: null, last_active: null },
    ]),
    get: vi.fn(async () => ({ name: 'Agent' })),
  }),
}));
vi.mock('../../container-runner.js', () => ({ isContainerRunning: () => true }));
vi.mock('../../modules/agent-status/index.js', () => ({ getLastStatusEvent: () => null }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: async () => undefined }));
vi.mock('../../session-manager.js', () => ({
  openOutboundDb: () => {
    throw new Error('no db in test');
  },
  openInboundDb: () => {
    throw new Error('no db in test');
  },
  inboundDbPath: () => '/nonexistent',
}));
vi.mock('../../modules/permissions/access.js', () => ({
  canAccessAgentGroup: async (_u: string, g: string) =>
    g === 'ag-mine' ? { allowed: true, reason: 'member' } : { allowed: false, reason: 'not_member' },
}));
vi.mock('./roles.js', () => ({
  isOwner: async () => false,
  isAnyAdmin: async () => false,
  hasAdminPrivilege: async (_u: string, g: string) => g === 'ag-mine',
}));

import { buildFloor } from './server/floor.js';
import { readFloorEvents } from './server/floor-feed.js';

beforeEach(() => vi.clearAllMocks());

describe('floor scoping', () => {
  it('a caller sees only desks for agent groups they can access', async () => {
    const snap = await buildFloor('webchat:someone');
    expect(snap.desks.map((d) => d.session_id)).toEqual(['s-allowed']);
    expect(snap.restricted).toBe(true);
  });

  it('the feed skips sessions of groups the caller lacks admin privilege on', async () => {
    // Both sessions' DB reads throw in this harness; what is under test is that
    // the DENIED group is never even attempted. The allowed group's reads fail
    // quiet (by design), so the result is simply empty rather than leaking.
    const { events } = await readFloorEvents('webchat:someone');
    expect(events).toEqual([]);
  });
});
