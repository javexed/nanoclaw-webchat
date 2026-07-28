import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { upsertUserCredsCredential, upsertUserCredential } from '../user-credentials/db.js';
import { userCredsAgentIdentifier, WORKSPACE_DEFAULT_USER_ID } from '../user-credentials/identity.js';
import type { OnecliAdmin } from '../user-credentials/onecli-admin.js';
import {
  WORKSPACE,
  listToolSecrets,
  createToolSecret,
  deleteToolSecret,
  getGroupIsolation,
  isolateGroup,
  unisolateGroup,
} from './index.js';

/**
 * In-memory fake vault that models the REAL gateway rule, not just bookkeeping:
 * an `all`-mode agent receives every secret whose host pattern matches,
 * regardless of assignment; a `selective` agent receives only what is assigned.
 * `injectedFor()` is the thing worth asserting on — an earlier version of these
 * tests asserted on assignment alone and therefore "passed" while the feature
 * leaked every secret to every agent.
 */
function fakeAdmin(opts: { failSetSecrets?: boolean } = {}) {
  const secrets = new Map<string, { value: string; type: string; name?: string; hostPattern?: string }>();
  const agents = new Map<string, { uuid: string; secretIds: string[]; mode: 'all' | 'selective' }>();
  let n = 0;
  const byUuid = (uuid: string) => [...agents.values()].find((a) => a.uuid === uuid);
  const admin: OnecliAdmin = {
    async findAgentId(identifier) {
      return agents.get(identifier)?.uuid ?? null;
    },
    // repo B's OnecliAdmin gained listAgents (the paginated admin surface from
    // patch 3); the fork's mock predates it. Backed by the same in-memory map
    // so the fake stays self-consistent.
    async listAgents() {
      return [...agents.entries()].map(([identifier, a]) => ({
        id: a.uuid,
        identifier,
        secretMode: a.mode,
      }));
    },
    async ensureAgent(_name, identifier) {
      if (!agents.get(identifier)) agents.set(identifier, { uuid: `uuid-${identifier}`, secretIds: [], mode: 'all' });
      return agents.get(identifier)!.uuid;
    },
    async createAnthropicSecret(name, value) {
      const id = `sec-${++n}`;
      secrets.set(id, { value, type: 'anthropic', name, hostPattern: 'api.anthropic.com' });
      return id;
    },
    async createOpenAISecret(name, value) {
      const id = `sec-${++n}`;
      secrets.set(id, { value, type: 'openai', name, hostPattern: 'api.openai.com' });
      return id;
    },
    async createGenericSecret(name, value, spec) {
      const id = `sec-${++n}`;
      secrets.set(id, { value, type: 'generic', name, hostPattern: spec.hostPattern });
      return id;
    },
    async updateSecretValue(secretId, value) {
      secrets.set(secretId, { ...secrets.get(secretId)!, value });
    },
    async deleteSecret(secretId) {
      secrets.delete(secretId);
    },
    async setSecretMode(uuid, mode) {
      const a = byUuid(uuid);
      if (a) a.mode = mode;
    },
    async getSecretMode(uuid) {
      return byUuid(uuid)?.mode ?? null;
    },
    async listAgentSecretIds(uuid) {
      return [...(byUuid(uuid)?.secretIds ?? [])];
    },
    async listAllSecrets() {
      return [...secrets].map(([id, v]) => ({ id, type: v.type, name: v.name, hostPattern: v.hostPattern }));
    },
    async setSecrets(uuid, ids) {
      if (opts.failSetSecrets) throw new Error('vault unreachable');
      const a = byUuid(uuid);
      if (a) a.secretIds = [...ids];
    },
  };
  /** Secret ids the gateway would inject for this agent when calling `host`. */
  const injectedFor = (identifier: string, host: string): string[] => {
    const a = agents.get(identifier);
    if (!a) return [];
    const matches = (id: string) => secrets.get(id)?.hostPattern === host;
    return a.mode === 'all' ? [...secrets.keys()].filter(matches) : a.secretIds.filter(matches);
  };
  return { admin, secrets, agents, injectedFor };
}

async function seedGroupAgent(admin: OnecliAdmin, agentGroupId: string) {
  await admin.ensureAgent(agentGroupId, agentGroupId);
}

/** A workspace-default model credential — isolation refuses to run without one. */
function seedWorkspaceDefault() {
  upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-model', 'oauth_token');
}

async function seedMember(admin: OnecliAdmin, agentGroupId: string, userId: string) {
  const ident = userCredsAgentIdentifier(agentGroupId, userId);
  await admin.ensureAgent(`${userId} (UserCreds)`, ident);
  await admin.setSecretMode(`uuid-${ident}`, 'selective');
  upsertUserCredsCredential(userId, agentGroupId, ident, 'user-secret', 'api_key', 'claude');
  return ident;
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});
afterEach(() => closeDb());

describe('workspace-scoped secrets', () => {
  it('are unassigned yet injected for every all-mode agent', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedGroupAgent(admin, 'ag-1');
    await seedGroupAgent(admin, 'ag-2');
    const created = await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'v');
    expect(injectedFor('ag-1', 'dev.azure.com')).toContain(created.id);
    expect(injectedFor('ag-2', 'dev.azure.com')).toContain(created.id);
  });

  it('list returns metadata only — never the value', async () => {
    const { admin } = fakeAdmin();
    await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'super-secret-pat');
    const listed = await listToolSecrets(admin, WORKSPACE);
    expect(listed).toEqual([{ id: expect.any(String), label: 'dev.azure.com', hostPattern: 'dev.azure.com' }]);
    expect(JSON.stringify(listed)).not.toContain('super-secret-pat');
  });

  it('still reaches an ISOLATED agent — system-wide must not mean "except the locked-down ones"', async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    getDb().prepare(`INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)`).run('ag-1', 'a', 'a', '');
    await seedGroupAgent(admin, 'ag-1');
    await isolateGroup(admin, 'ag-1');
    const shared = await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'v');
    expect(injectedFor('ag-1', 'dev.azure.com')).toContain(shared.id);
  });

  it('does not appear in an agent-scoped listing', async () => {
    const { admin } = fakeAdmin();
    await seedGroupAgent(admin, 'ag-1');
    await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'v');
    expect(await listToolSecrets(admin, { kind: 'agent', agentGroupId: 'ag-1' })).toEqual([]);
  });
});

describe('agent-scoped secrets require isolation', () => {
  it('isolates an all-mode group on the fly rather than refusing', async () => {
    const { admin, agents, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    expect(agents.get('ag-1')!.mode).toBe('all');
    const created = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v');
    // The credential must never exist while the group is still open, or it
    // would be offered to every other all-mode agent in the install.
    expect(agents.get('ag-1')!.mode).toBe('selective');
    expect(injectedFor('ag-1', 'dev.azure.com')).toContain(created.id);
  });

  it('refuses — and stores nothing — when isolation is impossible', async () => {
    const { admin, secrets, agents } = fakeAdmin(); // no workspace default seeded
    await seedGroupAgent(admin, 'ag-1');
    await expect(
      createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v'),
    ).rejects.toThrow(/No model credential/);
    expect([...secrets.values()].filter((s) => s.type === 'generic')).toHaveLength(0);
    expect(agents.get('ag-1')!.mode).toBe('all'); // left untouched
  });

  it('reaches the isolated agent it was created for', async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await isolateGroup(admin, 'ag-1');
    const mine = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v');
    expect(injectedFor('ag-1', 'dev.azure.com')).toContain(mine.id);
  });

  // The limitation, asserted so nobody re-discovers it in production: isolating
  // group A controls what A RECEIVES. It cannot stop a still-`all`-mode group B
  // from also being offered A's secret, because `all` means "every secret in the
  // OneCLI project whose host matches". Scoping a secret to one agent therefore
  // requires every OTHER agent to be selective too (or separate projects).
  it('is STILL offered to other agents that remain in all mode', async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await seedGroupAgent(admin, 'ag-2');
    await isolateGroup(admin, 'ag-1');
    const mine = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v');
    expect(injectedFor('ag-2', 'dev.azure.com')).toContain(mine.id);
  });

  it('is hidden from another agent once THAT agent is isolated too', async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await seedGroupAgent(admin, 'ag-2');
    await isolateGroup(admin, 'ag-1');
    await isolateGroup(admin, 'ag-2');
    const mine = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v');
    expect(injectedFor('ag-1', 'dev.azure.com')).toContain(mine.id);
    expect(injectedFor('ag-2', 'dev.azure.com')).not.toContain(mine.id);
  });

  it('fans out to enrolled per-member agents', async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const aliceIdent = await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    const created = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v');
    expect(injectedFor(aliceIdent, 'dev.azure.com')).toContain(created.id);
  });

  it('deletes the secret if wiring fails, leaving no orphan credential', async () => {
    const { admin, secrets } = fakeAdmin({ failSetSecrets: true });
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    // isolate uses setSecrets too, so drive the failure at create time instead
    await admin.setSecretMode('uuid-ag-1', 'selective');
    await expect(
      createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v'),
    ).rejects.toThrow();
    expect([...secrets.values()].filter((s) => s.type === 'generic')).toHaveLength(0);
  });
});

describe('isolateGroup', () => {
  it('pins the model credential BEFORE flipping mode, so the agent never 401s', async () => {
    const { admin, agents } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await isolateGroup(admin, 'ag-1');
    const a = agents.get('ag-1')!;
    expect(a.mode).toBe('selective');
    expect(a.secretIds).toContain('sec-model');
  });

  it('refuses when no model credential can be resolved', async () => {
    const { admin, agents } = fakeAdmin();
    await seedGroupAgent(admin, 'ag-1');
    await expect(isolateGroup(admin, 'ag-1')).rejects.toThrow(/No model credential/);
    expect(agents.get('ag-1')!.mode).toBe('all'); // left untouched
  });

  it('refuses when the group has no OneCLI agent yet', async () => {
    const { admin } = fakeAdmin();
    await expect(isolateGroup(admin, 'ag-missing')).rejects.toThrow(/No OneCLI agent/);
  });

  it('is idempotent', async () => {
    const { admin } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await isolateGroup(admin, 'ag-1');
    await isolateGroup(admin, 'ag-1');
    expect((await getGroupIsolation(admin, 'ag-1')).isolated).toBe(true);
  });

  it('un-isolating restores all-mode injection', async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await seedGroupAgent(admin, 'ag-2');
    await isolateGroup(admin, 'ag-2');
    const shared = await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'v');
    expect(injectedFor('ag-2', 'dev.azure.com')).not.toContain(shared.id); // isolated: opted out
    await unisolateGroup(admin, 'ag-2');
    expect(injectedFor('ag-2', 'dev.azure.com')).toContain(shared.id);
  });
});

describe('getGroupIsolation', () => {
  it('reports unavailable when the group has no OneCLI agent', async () => {
    const { admin } = fakeAdmin();
    expect(await getGroupIsolation(admin, 'ag-none')).toEqual({ isolated: false, available: false });
  });
});

describe('deleteToolSecret', () => {
  it('unwires and deletes, including from member agents', async () => {
    const { admin, secrets, agents } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const aliceIdent = await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    const created = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v');
    expect(await deleteToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, created.id)).toBe(true);
    expect(secrets.has(created.id)).toBe(false);
    expect(agents.get(aliceIdent)!.secretIds).not.toContain(created.id);
  });

  it('refuses a secret outside the scope, so one group cannot delete another’s', async () => {
    const { admin, secrets } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await seedGroupAgent(admin, 'ag-2');
    await isolateGroup(admin, 'ag-2');
    const theirs = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-2' }, 'dev.azure.com', 'v');
    expect(await deleteToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, theirs.id)).toBe(false);
    expect(secrets.has(theirs.id)).toBe(true);
  });

  it('refuses to delete a workspace secret via an agent scope', async () => {
    const { admin, secrets } = fakeAdmin();
    await seedGroupAgent(admin, 'ag-1');
    const shared = await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'v');
    expect(await deleteToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, shared.id)).toBe(false);
    expect(secrets.has(shared.id)).toBe(true);
  });
});

describe('user-scoped secrets and precedence', () => {
  it('reaches only that person, not the group agent or another member', async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const alice = await seedMember(admin, 'ag-1', 'webchat:alice');
    const bob = await seedMember(admin, 'ag-1', 'webchat:bob');
    const hers = await createToolSecret(
      admin,
      { kind: 'user', agentGroupId: 'ag-1', userId: 'webchat:alice' },
      'dev.azure.com',
      'pat-a',
    );
    expect(injectedFor(alice, 'dev.azure.com')).toContain(hers.id);
    expect(injectedFor(bob, 'dev.azure.com')).not.toContain(hers.id);
  });

  it('Person A and Person B each push with their OWN PAT', async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const alice = await seedMember(admin, 'ag-1', 'webchat:alice');
    const bob = await seedMember(admin, 'ag-1', 'webchat:bob');
    const patA = await createToolSecret(
      admin,
      { kind: 'user', agentGroupId: 'ag-1', userId: 'webchat:alice' },
      'dev.azure.com',
      'pat-a',
    );
    const patB = await createToolSecret(
      admin,
      { kind: 'user', agentGroupId: 'ag-1', userId: 'webchat:bob' },
      'dev.azure.com',
      'pat-b',
    );
    expect(injectedFor(alice, 'dev.azure.com')).toEqual([patA.id]);
    expect(injectedFor(bob, 'dev.azure.com')).toEqual([patB.id]);
  });

  it("a member's own PAT WINS over the group's for the same host", async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const alice = await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    const groupPat = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'group');
    const hers = await createToolSecret(
      admin,
      { kind: 'user', agentGroupId: 'ag-1', userId: 'webchat:alice' },
      'dev.azure.com',
      'pat-a',
    );
    const injected = injectedFor(alice, 'dev.azure.com');
    expect(injected).toContain(hers.id);
    expect(injected).not.toContain(groupPat.id); // exactly one wins — no ambiguity
    expect(injected).toHaveLength(1);
  });

  it("falls back to the group's PAT when the member's is removed", async () => {
    const { admin, injectedFor } = fakeAdmin();
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const alice = await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    const groupPat = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'group');
    const scope = { kind: 'user' as const, agentGroupId: 'ag-1', userId: 'webchat:alice' };
    const hers = await createToolSecret(admin, scope, 'dev.azure.com', 'pat-a');
    await deleteToolSecret(admin, scope, hers.id);
    expect(injectedFor(alice, 'dev.azure.com')).toEqual([groupPat.id]);
  });

  it('refuses a user secret for someone who has not connected credentials', async () => {
    const { admin, secrets } = fakeAdmin();
    await seedGroupAgent(admin, 'ag-1');
    await expect(
      createToolSecret(admin, { kind: 'user', agentGroupId: 'ag-1', userId: 'webchat:nobody' }, 'dev.azure.com', 'v'),
    ).rejects.toThrow(/has not connected/);
    expect([...secrets.values()].filter((s) => s.type === 'generic')).toHaveLength(0);
  });

  it('refuses a duplicate host at the same scope', async () => {
    const { admin } = fakeAdmin();
    await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'v1');
    await expect(createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'v2')).rejects.toThrow(/already exists/);
  });
});
