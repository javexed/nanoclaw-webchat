import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getUserCredsCredential, upsertUserCredsCredential, upsertUserCredential } from '../user-credentials/db.js';
import { userCredsAgentIdentifier, WORKSPACE_DEFAULT_USER_ID } from '../user-credentials/identity.js';
import type { OnecliAdmin } from '../user-credentials/onecli-admin.js';
import {
  WORKSPACE,
  effectiveSecretsFor,
  listToolSecrets,
  createToolSecret,
  deleteToolSecret,
  groupsWithPersonalSecrets,
  updateToolSecret,
  basicAuthValue,
  getGroupIsolation,
  isolateGroup,
  unisolateGroup,
  injectionForHost,
  resolveAuthScheme,
  resolveBasicCredential,
  parseCustomScheme,
  reconcileAllAgents,
  reconcileGroupAgents,
  registerAssignedSecretSource,
} from './index.js';

/**
 * In-memory fake vault that models the REAL gateway rule, not just bookkeeping:
 * an `all`-mode agent receives every secret whose host pattern matches,
 * regardless of assignment; a `selective` agent receives only what is assigned.
 * `injectedFor()` is the thing worth asserting on — assignment alone can
 * "pass" while every secret leaks to every agent.
 */
function fakeAdmin(opts: { failSetSecrets?: boolean } = {}) {
  const secrets = new Map<
    string,
    { value: string; type: string; name?: string; hostPattern?: string; headerName?: string; valueFormat?: string }
  >();
  const agents = new Map<string, { uuid: string; secretIds: string[]; mode: 'all' | 'selective' }>();
  let n = 0;
  const byUuid = (uuid: string) => [...agents.values()].find((a) => a.uuid === uuid);
  const admin: OnecliAdmin = {
    async findAgentId(identifier) {
      return agents.get(identifier)?.uuid ?? null;
    },
    // Backed by the same in-memory map so the fake stays self-consistent.
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
      // Record headerName/valueFormat too: how a credential goes ON THE WIRE is
      // the whole difference between schemes, and a fake that drops it cannot
      // catch a Bearer header being sent to an API that wants a different one.
      secrets.set(id, {
        value,
        type: 'generic',
        name,
        hostPattern: spec.hostPattern,
        headerName: spec.headerName,
        valueFormat: spec.valueFormat,
      });
      return id;
    },
    async updateSecretValue(secretId, value) {
      secrets.set(secretId, { ...secrets.get(secretId)!, value });
    },
    async updateGenericSecret(secretId, value, spec) {
      secrets.set(secretId, { ...secrets.get(secretId)!, value, ...spec });
    },
    async deleteSecret(secretId) {
      secrets.delete(secretId);
    },
    async updateSecretPathPattern() {},
    async deleteAgent() {},
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
      // With the wire settings, as the real listing reads them back from injectionConfig.
      return [...secrets].map(([id, v]) => ({
        id,
        type: v.type,
        name: v.name,
        hostPattern: v.hostPattern,
        headerName: v.headerName,
        valueFormat: v.valueFormat,
      }));
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
async function seedWorkspaceDefault() {
  await upsertUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude', 'sec-model', 'oauth_token');
}

async function seedMember(admin: OnecliAdmin, agentGroupId: string, userId: string) {
  const ident = userCredsAgentIdentifier(agentGroupId, userId);
  await admin.ensureAgent(`${userId} (UserCreds)`, ident);
  await admin.setSecretMode(`uuid-${ident}`, 'selective');
  await upsertUserCredsCredential(userId, agentGroupId, ident, 'user-secret', 'api_key', 'claude');
  return ident;
}

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
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
    expect(listed).toEqual([
      { id: expect.any(String), label: 'dev.azure.com', hostPattern: 'dev.azure.com', kind: 'token' },
    ]);
    expect(JSON.stringify(listed)).not.toContain('super-secret-pat');
  });

  it('still reaches an ISOLATED agent — system-wide must not mean "except the locked-down ones"', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
    await getDb().run(`INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)`, 'ag-1', 'a', 'a', '');
    await seedGroupAgent(admin, 'ag-1');
    await isolateGroup(admin, 'ag-1');
    const shared = await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'v');
    expect(injectedFor('ag-1', 'dev.azure.com')).toContain(shared.id);
  });

  it('reaches an agent created and isolated AFTER it was saved', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
    const shared = await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'v');
    // The agent first appears now (its first spawn), and fleet isolation locks it down.
    await seedGroupAgent(admin, 'ag-new');
    await isolateGroup(admin, 'ag-new');
    expect(injectedFor('ag-new', 'dev.azure.com')).toContain(shared.id);
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
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await seedGroupAgent(admin, 'ag-2');
    await isolateGroup(admin, 'ag-1');
    const mine = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v');
    expect(injectedFor('ag-2', 'dev.azure.com')).toContain(mine.id);
  });

  it('is hidden from another agent once THAT agent is isolated too', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const aliceIdent = await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    const created = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v');
    expect(injectedFor(aliceIdent, 'dev.azure.com')).toContain(created.id);
  });

  it('deletes the secret if wiring fails, leaving no orphan credential', async () => {
    const { admin, secrets } = fakeAdmin({ failSetSecrets: true });
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await isolateGroup(admin, 'ag-1');
    await isolateGroup(admin, 'ag-1');
    expect((await getGroupIsolation(admin, 'ag-1')).isolated).toBe(true);
  });

  it('un-isolating restores all-mode injection', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
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

describe('updateToolSecret', () => {
  it('gives a secret a new value in place: same id, still assigned, no second secret', async () => {
    const { admin, secrets, agents } = fakeAdmin();
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const aliceIdent = await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    const scope = { kind: 'agent' as const, agentGroupId: 'ag-1' };
    const created = await createToolSecret(admin, scope, 'api.github.com', 'old-pat');
    const updated = await updateToolSecret(admin, scope, created.id, 'new-pat');
    expect(updated).toMatchObject({ id: created.id, hostPattern: 'api.github.com', kind: 'token' });
    expect(secrets.get(created.id)).toMatchObject({ value: 'new-pat', valueFormat: 'Bearer {value}' });
    expect(agents.get(aliceIdent)!.secretIds).toContain(created.id);
    expect(await listToolSecrets(admin, scope)).toHaveLength(1);
  });

  it('changes the kind in place — a token becomes a username + password, and back — and reads it back', async () => {
    const { admin, secrets } = fakeAdmin();
    const created = await createToolSecret(admin, WORKSPACE, 'caldav.example.com', 'tok');
    const basic = resolveBasicCredential({ username: 'me', password: 'hunter2' });
    if ('error' in basic) throw new Error(basic.error);
    await updateToolSecret(admin, WORKSPACE, created.id, basic.value, basic.scheme);
    expect(secrets.get(created.id)).toMatchObject({ headerName: 'Authorization', valueFormat: 'Basic {value}' });
    expect(secrets.get(created.id)!.value).toBe(Buffer.from('me:hunter2').toString('base64'));
    expect((await listToolSecrets(admin, WORKSPACE))[0]).toMatchObject({ id: created.id, kind: 'basic' });
    await updateToolSecret(admin, WORKSPACE, created.id, 'tok2');
    expect(secrets.get(created.id)).toMatchObject({ value: 'tok2', valueFormat: 'Bearer {value}' });
    expect((await listToolSecrets(admin, WORKSPACE))[0].kind).toBe('token');
  });

  it('reads a custom header back with its header and template, and keeps a host’s own encoding', async () => {
    const { admin, secrets } = fakeAdmin();
    const custom = await createToolSecret(admin, WORKSPACE, 'api.example.org', 'k', {
      headerName: 'X-Api-Key',
      valueFormat: '{value}',
    });
    expect((await listToolSecrets(admin, WORKSPACE)).find((s) => s.id === custom.id)).toMatchObject({
      kind: 'custom',
      headerName: 'X-Api-Key',
      valueFormat: '{value}',
    });
    // Azure DevOps takes a PAT as HTTP Basic: an update encodes it exactly as adding did.
    const ado = await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'pat1');
    await updateToolSecret(admin, WORKSPACE, ado.id, 'pat2');
    expect(secrets.get(ado.id)!.value).toBe(basicAuthValue('', 'pat2'));
  });

  it('refuses a secret outside the scope, and changes nothing', async () => {
    const { admin, secrets } = fakeAdmin();
    await seedGroupAgent(admin, 'ag-1');
    const shared = await createToolSecret(admin, WORKSPACE, 'api.github.com', 'v');
    expect(await updateToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, shared.id, 'hijack')).toBeNull();
    expect(await updateToolSecret(admin, WORKSPACE, 'sec-nope', 'x')).toBeNull();
    expect(secrets.get(shared.id)!.value).toBe('v');
  });
});

describe('deleteToolSecret', () => {
  it('unwires and deletes, including from member agents', async () => {
    const { admin, secrets, agents } = fakeAdmin();
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
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
    await seedWorkspaceDefault();
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

/**
 * Wire format. Host inference can't cover a self-hosted API (a LAN address),
 * and getting it wrong is silent — a 401 from a credential that IS in the vault.
 */
describe('wire format', () => {
  it('still infers from the host when nothing is stated', async () => {
    expect(injectionForHost('api.github.com')).toMatchObject({
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    });
    expect(injectionForHost('gitlab.com')).toMatchObject({ headerName: 'PRIVATE-TOKEN', valueFormat: '{value}' });
    expect(injectionForHost('dev.azure.com')).toMatchObject({ encodeBasic: true, valueFormat: 'Basic {value}' });
  });

  // Addresses here are synthetic (192.168.0.x) on purpose: this tree is published
  // to a public mirror, and a real LAN address in a fixture leaks the operator's
  // network. check-public-tree.sh enforces it.
  it('falls back to Bearer for an unrecognised host, as before', async () => {
    expect(injectionForHost('192.168.0.10')).toMatchObject({
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    });
  });

  // The point of the feature: a stated scheme reaches hosts inference cannot.
  it('uses a stated scheme, overriding inference', async () => {
    expect(injectionForHost('192.168.0.10', { headerName: 'X-Api-Key', valueFormat: '{value}' })).toMatchObject({
      hostPattern: '192.168.0.10',
      headerName: 'X-Api-Key',
      valueFormat: '{value}',
    });
    // Even for a host that WOULD infer — the operator's statement wins.
    expect(
      injectionForHost('gitlab.com', { headerName: 'Authorization', valueFormat: 'Bearer {value}' }),
    ).toMatchObject({ headerName: 'Authorization', valueFormat: 'Bearer {value}' });
  });

  it('expresses any real-world scheme without a code change', async () => {
    // Shapes drawn from actual APIs — none of which the codebase names.
    const cases = [
      { headerName: 'X-Api-Key', valueFormat: '{value}' },
      { headerName: 'Authorization', valueFormat: 'Token {value}' },
      { headerName: 'Authorization', valueFormat: 'PVEAPIToken={value}' },
      { headerName: 'X-Auth-Token', valueFormat: '{value}' },
    ];
    for (const c of cases) expect(resolveAuthScheme(c)).toEqual(c);
  });

  it('preserves the host pattern verbatim so scoping is unchanged', async () => {
    expect(injectionForHost('*.example.com', { headerName: 'X-Api-Key', valueFormat: '{value}' }).hostPattern).toBe(
      '*.example.com',
    );
  });

  it('rejects anything that is not a {headerName, valueFormat} pair', async () => {
    for (const bad of ['bearer', 'X-Custom-Header', '', undefined, null, 42, 'constructor', 'toString'])
      expect(resolveAuthScheme(bad)).toHaveProperty('error');
  });

  it('rejects header names that are not HTTP tokens', async () => {
    for (const bad of ['X Api Key', 'X-Api-Key:', 'X\nInjected', '', 'a'.repeat(65), 'Ünicode'])
      expect(parseCustomScheme(bad, '{value}')).toHaveProperty('error');
  });

  it('rejects headers that control the request rather than authenticate it', async () => {
    for (const bad of ['Host', 'host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Proxy-Authorization'])
      expect(parseCustomScheme(bad, '{value}')).toHaveProperty('error');
  });

  it('requires exactly one {value} — zero would never send the credential', async () => {
    expect(parseCustomScheme('X-Api-Key', 'no placeholder')).toHaveProperty('error');
    expect(parseCustomScheme('X-Api-Key', '{value} {value}')).toHaveProperty('error');
    expect(parseCustomScheme('X-Api-Key', '{value}')).not.toHaveProperty('error');
  });

  // CR/LF in a header value is request splitting, and the template is the one
  // operator-supplied string that reaches a header verbatim.
  it('rejects templates that could split the request', async () => {
    expect(parseCustomScheme('X-Api-Key', 'a\r\nX-Evil: 1 {value}')).toHaveProperty('error');
    expect(parseCustomScheme('X-Api-Key', 'a\n{value}')).toHaveProperty('error');
    expect(parseCustomScheme('X-Api-Key', `{value}${'x'.repeat(200)}`)).toHaveProperty('error');
  });

  it('carries a stated scheme through createToolSecret to the stored spec', async () => {
    const { admin, secrets } = fakeAdmin();
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'g1');
    await createToolSecret(admin, { kind: 'agent', agentGroupId: 'g1' }, '192.168.0.10', 'k', {
      headerName: 'X-Api-Key',
      valueFormat: '{value}',
    });
    const stored = [...secrets.values()].find((x) => x.hostPattern === '192.168.0.10');
    expect(stored?.headerName).toBe('X-Api-Key');
    expect(stored?.valueFormat).toBe('{value}');
  });

  it('without one, the same host would be sent the WRONG header', async () => {
    const { admin, secrets } = fakeAdmin();
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'g2');
    await createToolSecret(admin, { kind: 'agent', agentGroupId: 'g2' }, '192.168.0.10', 'k');
    const stored = [...secrets.values()].find((x) => x.hostPattern === '192.168.0.10');
    expect(stored?.headerName).toBe('Authorization');
    expect(stored?.valueFormat).toBe('Bearer {value}');
  });
});

describe('username + password', () => {
  const decode = (v: string) => Buffer.from(v, 'base64').toString('utf8');

  it('encodes user:password as UTF-8 base64 behind Authorization: Basic', () => {
    const r = resolveBasicCredential({ username: 'me@example.com', password: 'abcd-efgh-ijkl-mnop' });
    expect(r).toEqual({
      value: 'bWVAZXhhbXBsZS5jb206YWJjZC1lZmdoLWlqa2wtbW5vcA==',
      scheme: { headerName: 'Authorization', valueFormat: 'Basic {value}' },
    });
  });

  it('keeps non-ASCII intact and allows a colon in the password', () => {
    const r = resolveBasicCredential({ username: 'jürgen', password: 'pä:ss€' });
    expect('value' in r && decode(r.value)).toBe('jürgen:pä:ss€');
  });

  it('rejects a missing, colon-bearing, control-character or overlong username', () => {
    for (const username of [undefined, '', 42, 'a:b', 'a\nb', 'a\x7F', 'u'.repeat(257)])
      expect(resolveBasicCredential({ username, password: 'p' })).toHaveProperty('error');
    expect(resolveBasicCredential({ username: 'u'.repeat(256), password: 'p' })).not.toHaveProperty('error');
  });

  it('rejects a missing or overlong password, and a non-object', () => {
    for (const password of [undefined, '', 7, 'p'.repeat(257)])
      expect(resolveBasicCredential({ username: 'u', password })).toHaveProperty('error');
    for (const bad of [undefined, null, 'u:p', ['u', 'p']]) expect(resolveBasicCredential(bad)).toHaveProperty('error');
  });

  it('never quotes either field in an error', () => {
    const r = resolveBasicCredential({ username: 'who:ami', password: 'hunter2' });
    expect(JSON.stringify(r)).not.toMatch(/who|ami|hunter2/);
  });

  it('stores the encoded pair with the Basic scheme and returns metadata only', async () => {
    const { admin, secrets } = fakeAdmin();
    const r = resolveBasicCredential({ username: 'me@example.com', password: 'app-pass' });
    if ('error' in r) throw new Error(r.error);
    const created = await createToolSecret(admin, WORKSPACE, 'caldav.icloud.com', r.value, r.scheme);
    expect(Object.keys(created).sort()).toEqual(['hostPattern', 'id', 'label']);
    const stored = [...secrets.values()].find((x) => x.hostPattern === 'caldav.icloud.com');
    expect(stored).toMatchObject({ headerName: 'Authorization', valueFormat: 'Basic {value}' });
    expect(decode(stored!.value)).toBe('me@example.com:app-pass');
    expect(JSON.stringify(await listToolSecrets(admin, WORKSPACE))).not.toContain(r.value);
  });

  it('leaves the Azure DevOps empty-username encoding unchanged', async () => {
    const { admin, secrets } = fakeAdmin();
    await createToolSecret(admin, WORKSPACE, 'dev.azure.com', 'pat');
    expect([...secrets.values()][0].value).toBe(Buffer.from(':pat').toString('base64'));
  });
});

describe('createToolSecret — host normalisation', () => {
  it('stores the host lowercased, so a phone-capitalised entry still matches', async () => {
    const { admin, injectedFor } = fakeAdmin();
    const created = await createToolSecret(admin, WORKSPACE, 'Dev.azure.com', 'pat');
    expect(created.hostPattern).toBe('dev.azure.com');
    expect(created.label).toBe('dev.azure.com');
    await seedGroupAgent(admin, 'ag-1');
    expect(injectedFor('ag-1', 'dev.azure.com')).toContain(created.id);
  });
});

describe('effectiveSecretsFor — the precedence, read back for display', () => {
  it('names the scope each host is served from, nearest first', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
    // The workspace reconcile walks agent_groups, so the group must exist as a row.
    await getDb().run(`INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)`, 'ag-1', 'a', 'a', '');
    await seedGroupAgent(admin, 'ag-1');
    const alice = await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    const mine = await createToolSecret(
      admin,
      { kind: 'user', agentGroupId: 'ag-1', userId: 'webchat:alice' },
      'github.com',
      'pat-a',
    );
    await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'github.com', 'pat-group');
    const groupAz = await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'pat-az');
    const ws = await createToolSecret(admin, WORKSPACE, 'api.openai.com', 'sk-ws');

    const effective = await effectiveSecretsFor(admin, 'ag-1', 'webchat:alice');
    expect(Object.fromEntries(effective.map((e) => [e.hostPattern, e.source]))).toEqual({
      'github.com': 'user',
      'dev.azure.com': 'agent',
      'api.openai.com': 'workspace',
    });
    // Not a parallel implementation: what it says is what the vault sends.
    for (const e of effective) expect(injectedFor(alice, e.hostPattern)).toEqual([e.secretId]);
    expect(effective.find((e) => e.hostPattern === 'github.com')?.secretId).toBe(mine.id);
    expect(effective.find((e) => e.hostPattern === 'dev.azure.com')?.secretId).toBe(groupAz.id);
    expect(effective.find((e) => e.hostPattern === 'api.openai.com')?.secretId).toBe(ws.id);
  });

  it('has no user scope for someone who is not enrolled — they run on the group agent', async () => {
    const { admin } = fakeAdmin();
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    await createToolSecret(
      admin,
      { kind: 'user', agentGroupId: 'ag-1', userId: 'webchat:alice' },
      'github.com',
      'pat-a',
    );
    await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'github.com', 'pat-group');

    const bob = await effectiveSecretsFor(admin, 'ag-1', 'webchat:bob');
    expect(bob).toHaveLength(1);
    expect(bob[0]).toMatchObject({ hostPattern: 'github.com', source: 'agent' });
  });
});

describe('Grok members (their model credential is `generic`, like a tool secret)', () => {
  async function seedGrokMember(admin: OnecliAdmin, agentGroupId: string, userId: string) {
    const ident = userCredsAgentIdentifier(agentGroupId, userId);
    const uuid = await admin.ensureAgent(`${userId} (UserCreds)`, ident);
    await admin.setSecretMode(uuid, 'selective');
    const grok = await admin.createGenericSecret(`UserCreds ${userId} (grok)`, 'grok-token', {
      hostPattern: 'cli-chat-proxy.grok.com',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    });
    await admin.setSecrets(uuid, [grok]);
    await upsertUserCredsCredential(userId, agentGroupId, ident, grok, 'oauth_token', 'grok');
    return { ident, grok };
  }

  it('keeps the Grok credential when a tool secret changes, and gets the tool secret', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const { ident, grok } = await seedGrokMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    const agent = { kind: 'agent' as const, agentGroupId: 'ag-1' };
    const pat = await createToolSecret(admin, agent, 'dev.azure.com', 'v');
    expect(injectedFor(ident, 'cli-chat-proxy.grok.com')).toEqual([grok]);
    expect(injectedFor(ident, 'dev.azure.com')).toEqual([pat.id]);

    // A second change must not swap the credential for the first PAT either.
    await createToolSecret(admin, agent, 'api.github.com', 'v2');
    expect(injectedFor(ident, 'cli-chat-proxy.grok.com')).toEqual([grok]);
    expect(injectedFor(ident, 'dev.azure.com')).toEqual([pat.id]);
  });
});

describe('a registered secret source (the cloud-model router key)', () => {
  // Module-global registry: the source answers only while a test sets the id,
  // and wants it for the groups in `served` (the router serves their model).
  let routerSecret: string | null = null;
  const served = new Set<string>();
  registerAssignedSecretSource({
    ids: async () => (routerSecret ? [routerSecret] : []),
    wants: async (agentGroupId) => served.has(agentGroupId),
  });
  afterEach(() => {
    routerSecret = null;
    served.clear();
  });

  async function routerKey(admin: OnecliAdmin): Promise<string> {
    return admin.createGenericSecret('LiteLLM inst router', 'sk-x', {
      hostPattern: 'nanoclaw-litellm',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    });
  }

  it('reaches the isolated agents it serves, members included, and survives a later tool-secret change', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
    await getDb().run(`INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)`, 'ag-1', 'a', 'a', '');
    await seedGroupAgent(admin, 'ag-1');
    const aliceIdent = await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    served.add('ag-1');
    routerSecret = await routerKey(admin);
    await reconcileAllAgents(admin);
    expect(injectedFor('ag-1', 'nanoclaw-litellm')).toEqual([routerSecret]);
    expect(injectedFor(aliceIdent, 'nanoclaw-litellm')).toEqual([routerSecret]);
    // A member's list is rewritten whole on a tool-secret change: the router key stays in it.
    await createToolSecret(admin, { kind: 'agent', agentGroupId: 'ag-1' }, 'dev.azure.com', 'v');
    expect(injectedFor(aliceIdent, 'nanoclaw-litellm')).toEqual([routerSecret]);
    expect(injectedFor('ag-1', 'nanoclaw-litellm')).toEqual([routerSecret]);
  });

  it('stays off agents on another model, and leaves once their model moves off the router', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
    for (const g of ['ag-1', 'ag-2']) {
      await getDb().run(`INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)`, g, g, g, '');
      await seedGroupAgent(admin, g);
      await isolateGroup(admin, g);
    }
    const aliceIdent = await seedMember(admin, 'ag-2', 'webchat:alice');
    served.add('ag-1');
    routerSecret = await routerKey(admin);
    await reconcileAllAgents(admin);
    expect(injectedFor('ag-1', 'nanoclaw-litellm')).toEqual([routerSecret]);
    expect(injectedFor('ag-2', 'nanoclaw-litellm')).toEqual([]);
    expect(injectedFor(aliceIdent, 'nanoclaw-litellm')).toEqual([]);
    // ag-1 moves to a local model: the next reconcile of its group drops the key.
    served.delete('ag-1');
    await reconcileGroupAgents(admin, 'ag-1');
    expect(injectedFor('ag-1', 'nanoclaw-litellm')).toEqual([]);
    // A member holding the key with no credential of their own: the key is
    // `generic` and not a tool secret, yet it is not mistaken for their model
    // credential and kept.
    await upsertUserCredsCredential('webchat:alice', 'ag-2', aliceIdent, null, 'api_key', 'claude');
    await admin.setSecrets(`uuid-${aliceIdent}`, [routerSecret]);
    await reconcileGroupAgents(admin, 'ag-2');
    expect(injectedFor(aliceIdent, 'nanoclaw-litellm')).toEqual([]);
  });

  it('isolating a group the router does not serve does not carry a held router key over', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
    await getDb().run(`INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)`, 'ag-1', 'a', 'a', '');
    await seedGroupAgent(admin, 'ag-1');
    routerSecret = await routerKey(admin);
    await admin.setSecrets('uuid-ag-1', [routerSecret]);
    await isolateGroup(admin, 'ag-1');
    expect(injectedFor('ag-1', 'nanoclaw-litellm')).toEqual([]);
  });

  it('is gone from every agent once the source stops naming it', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
    await getDb().run(`INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)`, 'ag-1', 'a', 'a', '');
    await seedGroupAgent(admin, 'ag-1');
    const aliceIdent = await seedMember(admin, 'ag-1', 'webchat:alice');
    await isolateGroup(admin, 'ag-1');
    served.add('ag-1');
    routerSecret = await routerKey(admin);
    await reconcileAllAgents(admin);
    await admin.deleteSecret(routerSecret);
    routerSecret = null;
    await reconcileAllAgents(admin);
    expect(injectedFor('ag-1', 'nanoclaw-litellm')).toEqual([]);
    expect(injectedFor(aliceIdent, 'nanoclaw-litellm')).toEqual([]);
  });
});

describe('personal secrets without a Claude credential of their own', () => {
  /** A member enrolled for personal secrets alone (user-credentials ensurePersonalEnrollment): no key of theirs. */
  async function seedPersonalMember(admin: OnecliAdmin, agentGroupId: string, userId: string) {
    const ident = userCredsAgentIdentifier(agentGroupId, userId);
    await admin.ensureAgent(`${userId} (UserCreds)`, ident);
    await admin.setSecretMode(`uuid-${ident}`, 'selective');
    await upsertUserCredsCredential(userId, agentGroupId, ident, null, 'api_key', 'claude');
    return ident;
  }
  const alice = { kind: 'user' as const, agentGroupId: 'ag-1', userId: 'webchat:alice' };

  it('their PAT reaches only them, and their last one removed takes them back to the shared session', async () => {
    const { admin, injectedFor } = fakeAdmin();
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    const ident = await seedPersonalMember(admin, 'ag-1', 'webchat:alice');
    // The route isolates the fleet before a personal secret (ensureFleetIsolation):
    // an `all`-mode agent would be offered her PAT too.
    await isolateGroup(admin, 'ag-1');
    const a = await createToolSecret(admin, alice, 'dev.azure.com', 'pat-a');
    const b = await createToolSecret(admin, alice, 'github.com', 'pat-b');
    expect(injectedFor(ident, 'dev.azure.com')).toEqual([a.id]);
    expect(injectedFor('ag-1', 'dev.azure.com')).toEqual([]);

    await deleteToolSecret(admin, alice, a.id);
    expect((await getUserCredsCredential('webchat:alice', 'ag-1'))!.status).toBe('active'); // one left
    await deleteToolSecret(admin, alice, b.id);
    expect((await getUserCredsCredential('webchat:alice', 'ag-1'))!.status).toBe('revoked');
  });

  it("removing the last one leaves an enrollment on the member's own key alone", async () => {
    const { admin } = fakeAdmin();
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await seedMember(admin, 'ag-1', 'webchat:alice');
    const a = await createToolSecret(admin, alice, 'dev.azure.com', 'pat-a');
    await deleteToolSecret(admin, alice, a.id);
    expect((await getUserCredsCredential('webchat:alice', 'ag-1'))!.status).toBe('active');
  });

  it('groupsWithPersonalSecrets names the agents a person holds personal secrets for', async () => {
    const { admin } = fakeAdmin();
    await seedWorkspaceDefault();
    await seedGroupAgent(admin, 'ag-1');
    await seedGroupAgent(admin, 'ag-2');
    await seedPersonalMember(admin, 'ag-1', 'webchat:alice');
    await createToolSecret(admin, alice, 'dev.azure.com', 'pat-a');
    expect(await groupsWithPersonalSecrets(admin, 'webchat:alice', ['ag-1', 'ag-2'])).toEqual(['ag-1']);
    expect(await groupsWithPersonalSecrets(admin, 'webchat:bob', ['ag-1', 'ag-2'])).toEqual([]);
  });
});
