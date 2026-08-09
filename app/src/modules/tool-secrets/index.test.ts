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
  injectionForHost,
  resolveAuthScheme,
  parseCustomScheme,
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

/**
 * Wire format.
 *
 * Host inference covers a public API, where the hostname names the service. It
 * cannot cover a self-hosted one, whose host is just a LAN address. Getting
 * this wrong is silent — the gateway injects `Authorization: Bearer …`, the
 * service ignores it, and the operator sees a 401 from a credential that IS in
 * the vault. So the scheme is statable, as a shape rather than a service list.
 */
describe('wire format', () => {
  it('still infers from the host when nothing is stated', () => {
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
  it('falls back to Bearer for an unrecognised host, as before', () => {
    expect(injectionForHost('192.168.0.10')).toMatchObject({
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    });
  });

  // The point of the feature: a stated scheme reaches hosts inference cannot.
  it('uses a stated scheme, overriding inference', () => {
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

  it('expresses any real-world scheme without a code change', () => {
    // Shapes drawn from actual APIs — none of which the codebase names.
    const cases = [
      { headerName: 'X-Api-Key', valueFormat: '{value}' },
      { headerName: 'Authorization', valueFormat: 'Token {value}' },
      { headerName: 'Authorization', valueFormat: 'PVEAPIToken={value}' },
      { headerName: 'X-Auth-Token', valueFormat: '{value}' },
    ];
    for (const c of cases) expect(resolveAuthScheme(c)).toEqual(c);
  });

  it('preserves the host pattern verbatim so scoping is unchanged', () => {
    expect(injectionForHost('*.example.com', { headerName: 'X-Api-Key', valueFormat: '{value}' }).hostPattern).toBe(
      '*.example.com',
    );
  });

  it('rejects anything that is not a {headerName, valueFormat} pair', () => {
    for (const bad of ['bearer', 'X-Custom-Header', '', undefined, null, 42, 'constructor', 'toString'])
      expect(resolveAuthScheme(bad)).toHaveProperty('error');
  });

  it('rejects header names that are not HTTP tokens', () => {
    for (const bad of ['X Api Key', 'X-Api-Key:', 'X\nInjected', '', 'a'.repeat(65), 'Ünicode'])
      expect(parseCustomScheme(bad, '{value}')).toHaveProperty('error');
  });

  it('rejects headers that control the request rather than authenticate it', () => {
    for (const bad of ['Host', 'host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Proxy-Authorization'])
      expect(parseCustomScheme(bad, '{value}')).toHaveProperty('error');
  });

  it('requires exactly one {value} — zero would never send the credential', () => {
    expect(parseCustomScheme('X-Api-Key', 'no placeholder')).toHaveProperty('error');
    expect(parseCustomScheme('X-Api-Key', '{value} {value}')).toHaveProperty('error');
    expect(parseCustomScheme('X-Api-Key', '{value}')).not.toHaveProperty('error');
  });

  // CR/LF in a header value is request splitting, and the template is the one
  // operator-supplied string that reaches a header verbatim.
  it('rejects templates that could split the request', () => {
    expect(parseCustomScheme('X-Api-Key', 'a\r\nX-Evil: 1 {value}')).toHaveProperty('error');
    expect(parseCustomScheme('X-Api-Key', 'a\n{value}')).toHaveProperty('error');
    expect(parseCustomScheme('X-Api-Key', `{value}${'x'.repeat(200)}`)).toHaveProperty('error');
  });

  it('carries a stated scheme through createToolSecret to the stored spec', async () => {
    const { admin, secrets } = fakeAdmin();
    seedWorkspaceDefault();
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
    seedWorkspaceDefault();
    await seedGroupAgent(admin, 'g2');
    await createToolSecret(admin, { kind: 'agent', agentGroupId: 'g2' }, '192.168.0.10', 'k');
    const stored = [...secrets.values()].find((x) => x.hostPattern === '192.168.0.10');
    expect(stored?.headerName).toBe('Authorization');
    expect(stored?.valueFormat).toBe('Bearer {value}');
  });
});
