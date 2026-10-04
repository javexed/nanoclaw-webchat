import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (orig) => ({ ...(await orig<object>()), INSTALL_SLUG: 'inst' }));
// No real container runtime: removeRouter's `rm -f` is recorded, never run.
const runtime = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('child_process', async (orig) => ({
  ...(await orig<object>()),
  execFile: (_bin: string, args: string[], ...rest: unknown[]) => {
    runtime.calls.push(args);
    (rest.find((r) => typeof r === 'function') as (err: Error | null) => void)(null);
  },
}));
// Every agent's assignment is tool-secrets' job; here only that it is asked to redo it.
type Source = { ids: (admin: unknown) => Promise<string[]>; wants: (agentGroupId: string) => Promise<boolean> };
const toolSecrets = vi.hoisted(() => ({
  reconcileAllAgents: vi.fn(async () => {}),
  reconcileGroupAgents: vi.fn(async () => {}),
  sources: [] as Source[],
}));
vi.mock('../../modules/tool-secrets/index.js', () => ({
  reconcileAllAgents: toolSecrets.reconcileAllAgents,
  reconcileGroupAgents: toolSecrets.reconcileGroupAgents,
  registerAssignedSecretSource: (source: Source) => void toolSecrets.sources.push(source),
}));
// Each group's model (its assignment, else the default), and its enrolled members.
const groups = vi.hoisted(() => ({
  models: new Map<string, { endpoint: string | null }>(),
  members: new Map<string, string[]>(),
}));
vi.mock('./db.js', async (orig) => ({
  ...(await orig<object>()),
  getEffectiveModelForAgent: async (id: string) => groups.models.get(id) ?? null,
}));
vi.mock('../../modules/user-credentials/db.js', async (orig) => ({
  ...(await orig<object>()),
  listGroupMemberEnrollments: async (id: string) => (groups.members.get(id) ?? []).map((user_id) => ({ user_id })),
}));

import type { OnecliAdmin } from '../../modules/user-credentials/onecli-admin.js';
import {
  agentRouterBase,
  CloudModelError,
  cloudModelMaxOutput,
  cloudModelNames,
  isRouterEndpoint,
  listProviderModels,
  prepareCloudModel,
  removeCloudModel,
  ensureRouterNetwork,
  removeRouter,
  ROUTER_PATHS,
  restrictCloudSecrets,
  routerAuthHeaders,
  routerIdentity,
  routerServesGroup,
  storedProviders,
  syncRouterSecretHold,
  upsertBackend,
} from './cloud-models.js';

const KEY = 'co-SECRET-key-123';
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-models-'));
  toolSecrets.reconcileAllAgents.mockClear();
  toolSecrets.reconcileGroupAgents.mockClear();
  groups.models.clear();
  groups.members.clear();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fakeAdmin(secrets: Array<{ id: string; name: string; pathPattern?: string | null }> = []) {
  const calls: string[] = [];
  const assigned: string[] = [];
  let n = 0;
  const admin = {
    ensureAgent: vi.fn(async () => 'agent-1'),
    findAgentId: vi.fn(async () => 'agent-1'),
    deleteAgent: vi.fn(async () => {}),
    setSecretMode: vi.fn(async (_id: string, mode: string) => void calls.push(`mode ${mode}`)),
    listAllSecrets: vi.fn(async () => secrets),
    createGenericSecret: vi.fn(async (name: string) =>
      name.includes(' router') ? `sec-router-${name.split(' ').pop()}` : `sec-new-${++n}`,
    ),
    updateSecretValue: vi.fn(async () => {}),
    updateSecretPathPattern: vi.fn(async () => {}),
    listAgentSecretIds: vi.fn(async () => [...assigned]),
    deleteSecret: vi.fn(async () => {}),
    setSecrets: vi.fn(async (_id: string, ids: string[]) => void assigned.splice(0, assigned.length, ...ids)),
  } as unknown as OnecliAdmin;
  return { admin, calls, assigned };
}
const containerConfig = async () => ({
  env: {
    HTTPS_PROXY: 'http://x:tok@host.docker.internal:10255',
    HTTP_PROXY: 'http://x:tok@host.docker.internal:10255',
  },
  caCertificate: '-----BEGIN CERTIFICATE-----\nONECLI\n-----END CERTIFICATE-----',
});
const allFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((e) => (e.isFile() ? [path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name)] : []));

describe('prepareCloudModel', () => {
  it('puts the key in the vault for the router identity only, and nowhere on disk', async () => {
    const { admin, calls, assigned } = fakeAdmin();
    await prepareCloudModel({ provider: 'cohere', model_id: 'command-a-03-2025', api_key: KEY }, root, {
      admin,
      containerConfig,
    });
    expect(admin.ensureAgent).toHaveBeenCalledWith('LiteLLM router', routerIdentity());
    expect(calls).toContain('mode selective');
    // One secret per path, each injected only there: never on LiteLLM's
    // pass-through paths (files, fine-tunes, …) of the same host.
    expect(admin.createGenericSecret).toHaveBeenCalledWith('LiteLLM inst cohere', KEY, {
      hostPattern: 'api.cohere.com',
      pathPattern: '/compatibility/v1/chat/completions',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    });
    expect(admin.createGenericSecret).toHaveBeenCalledWith('LiteLLM inst cohere 2', KEY, {
      hostPattern: 'api.cohere.com',
      pathPattern: '/v1/models',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    });
    // The router identity holds the provider keys only; the router secret is the agents'.
    expect(assigned).toEqual(['sec-new-1', 'sec-new-2']);
    const dir = path.join(root, 'data/litellm');
    const master = fs.readFileSync(path.join(dir, 'master.key'), 'utf8');
    expect(master).toMatch(/^sk-[0-9a-f]{64}$/);
    expect(fs.statSync(path.join(dir, 'master.key')).mode & 0o777).toBe(0o600);
    // On inference paths only: the master key is LiteLLM's admin credential too.
    for (const [id, pathPattern] of [
      ['messages', '/v1/messages*'],
      ['chat', '/v1/chat/completions*'],
      ['models', '/v1/models*'],
    ])
      expect(admin.createGenericSecret).toHaveBeenCalledWith(`LiteLLM inst router ${id}`, master, {
        hostPattern: 'nanoclaw-litellm',
        pathPattern,
        headerName: 'Authorization',
        valueFormat: 'Bearer {value}',
      });
    const routerCalls = vi
      .mocked(admin.createGenericSecret)
      .mock.calls.filter(([name]) => String(name).startsWith('LiteLLM inst router'));
    expect(routerCalls).toHaveLength(ROUTER_PATHS.length);
    expect(routerCalls.every(([, , spec]) => spec.pathPattern?.startsWith('/v1/'))).toBe(true);
    expect(toolSecrets.reconcileAllAgents).toHaveBeenCalledWith(admin);
    // The router's own outbound: local servers stay direct, past the gateway.
    expect(fs.readFileSync(path.join(dir, 'onecli.env'), 'utf8')).toMatch(/^NO_PROXY=.*host\.docker\.internal/m);
    for (const f of allFiles(root)) expect(fs.readFileSync(f, 'utf8')).not.toContain(KEY);
    expect(fs.statSync(path.join(dir, 'onecli.env')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, 'onecli.env'), 'utf8')).toMatch(/^HTTPS_PROXY=http:\/\/x:tok@/m);
    expect(fs.readFileSync(path.join(dir, 'onecli-ca.pem'), 'utf8')).toContain('ONECLI');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'backends.json'), 'utf8'))).toEqual([
      {
        model_name: 'command-a-03-2025',
        model: 'openai/command-a-03-2025',
        gateway: true,
        provider: 'cohere',
        api_base: 'https://api.cohere.com/compatibility/v1',
      },
    ]);
    expect(cloudModelNames(root)).toEqual(['command-a-03-2025']);
  });

  it('a second key for the same provider replaces the vault values, not second secrets', async () => {
    const { admin } = fakeAdmin([
      { id: 'sec-1', name: 'LiteLLM inst cohere', pathPattern: '/compatibility/v1/chat/completions' },
      { id: 'sec-2', name: 'LiteLLM inst cohere 2', pathPattern: '/v1/models' },
    ]);
    await prepareCloudModel({ provider: 'cohere', model_id: 'command-r', api_key: KEY }, root, {
      admin,
      containerConfig,
    });
    expect(admin.updateSecretValue).toHaveBeenCalledWith('sec-1', KEY);
    expect(admin.updateSecretValue).toHaveBeenCalledWith('sec-2', KEY);
    expect(vi.mocked(admin.createGenericSecret).mock.calls.map((c) => c[0])).toEqual([
      'LiteLLM inst router messages',
      'LiteLLM inst router chat',
      'LiteLLM inst router models',
    ]);
    expect(admin.updateSecretPathPattern).not.toHaveBeenCalled();
  });

  it('a key stored before path scoping is narrowed, and given again completes the set', async () => {
    const { admin } = fakeAdmin([{ id: 'sec-old', name: 'LiteLLM inst cohere', pathPattern: null }]);
    await prepareCloudModel({ provider: 'cohere', model_id: 'command-r', api_key: KEY }, root, {
      admin,
      containerConfig,
    });
    expect(admin.updateSecretPathPattern).toHaveBeenCalledWith('sec-old', '/compatibility/v1/chat/completions');
    expect(vi.mocked(admin.createGenericSecret).mock.calls.map((c) => c[0])).toEqual([
      'LiteLLM inst cohere 2',
      'LiteLLM inst router messages',
      'LiteLLM inst router chat',
      'LiteLLM inst router models',
    ]);
  });

  it('says whether the backend is new, so a failed install can withdraw only what it added', async () => {
    const { admin } = fakeAdmin();
    const deps = { admin, containerConfig };
    const input = { provider: 'cohere', model_id: 'command-r', api_key: KEY };
    expect((await prepareCloudModel(input, root, deps)).added).toBe(true);
    expect((await prepareCloudModel(input, root, deps)).added).toBe(false);
  });

  it('refuses an unknown provider, a malformed model and a malformed key, before touching the vault', async () => {
    const { admin } = fakeAdmin();
    const deps = { admin, containerConfig };
    await expect(prepareCloudModel({ provider: 'x', model_id: 'm', api_key: KEY }, root, deps)).rejects.toThrow(
      CloudModelError,
    );
    await expect(prepareCloudModel({ provider: 'cohere', model_id: 'a b', api_key: KEY }, root, deps)).rejects.toThrow(
      /Invalid model/,
    );
    await expect(prepareCloudModel({ provider: 'cohere', model_id: 'm', api_key: 'a b' }, root, deps)).rejects.toThrow(
      /Invalid key/,
    );
    expect(admin.ensureAgent).not.toHaveBeenCalled();
  });
});

describe('a stored key', () => {
  it('lets another model of the provider be added without the key again', async () => {
    const { admin } = fakeAdmin([
      { id: 'sec-1', name: 'LiteLLM inst cohere', pathPattern: '/compatibility/v1/chat/completions' },
      { id: 'sec-2', name: 'LiteLLM inst cohere 2', pathPattern: '/v1/models' },
    ]);
    await prepareCloudModel({ provider: 'cohere', model_id: 'command-a-plus-05-2026', api_key: '' }, root, {
      admin,
      containerConfig,
    });
    expect(admin.updateSecretValue).not.toHaveBeenCalledWith('sec-1', expect.anything());
    expect(admin.updateSecretValue).not.toHaveBeenCalledWith('sec-2', expect.anything());
    expect(cloudModelNames(root)).toEqual(['command-a-plus-05-2026']);
    const none = fakeAdmin();
    await expect(
      prepareCloudModel({ provider: 'cohere', model_id: 'x', api_key: '' }, root, {
        admin: none.admin,
        containerConfig,
      }),
    ).rejects.toThrow(/Invalid key/);
  });
});

describe('scoping keys stored before path scoping', () => {
  it('restrictCloudSecrets narrows an unscoped key to the inference path without its value', async () => {
    const { admin } = fakeAdmin([
      { id: 'sec-old', name: 'LiteLLM inst gemini', pathPattern: null },
      { id: 'other', name: 'ToolSecret x', pathPattern: null },
      { id: 'sec-r', name: 'LiteLLM inst router', pathPattern: null },
    ]);
    await restrictCloudSecrets(admin);
    expect(admin.updateSecretPathPattern).toHaveBeenCalledTimes(1);
    expect(admin.updateSecretPathPattern).toHaveBeenCalledWith('sec-old', '/v1beta/models/*:streamGenerateContent');
    expect(admin.updateSecretValue).not.toHaveBeenCalled();
    expect(admin.createGenericSecret).not.toHaveBeenCalled();
  });

  it('a provider counts as stored only with a key on every path, so the form asks for it once', async () => {
    expect(await storedProviders(fakeAdmin([{ id: 's', name: 'LiteLLM inst cohere' }]).admin)).toEqual([]);
    const full = fakeAdmin([
      { id: 's1', name: 'LiteLLM inst cohere' },
      { id: 's2', name: 'LiteLLM inst cohere 2' },
    ]);
    expect(await storedProviders(full.admin)).toEqual(['cohere']);
  });
});

describe('listProviderModels', () => {
  it("reads the provider's chat models through the gateway, sorted and unique", async () => {
    fs.mkdirSync(path.join(root, 'data/litellm'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/litellm/onecli.env'), 'HTTPS_PROXY=http://x:t@host.docker.internal:10255\n');
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      return JSON.stringify({ models: [{ name: 'command-r' }, { name: 'command-a-03-2025' }, { name: 'command-r' }] });
    };
    expect(await listProviderModels('cohere', root, get)).toEqual(['command-a-03-2025', 'command-r']);
    expect(urls[0]).toMatch(/^https:\/\/api\.cohere\.com\/v1\/models\?endpoint=chat/);
    await expect(listProviderModels('cohere', root, async () => '<html>')).rejects.toThrow(/No list/);
  });
});

describe('removeCloudModel', () => {
  it("drops the backend, and the provider's keys only with its last model", async () => {
    upsertBackend(root, { model_name: 'a', model: 'cohere_chat/a', gateway: true });
    upsertBackend(root, { model_name: 'b', model: 'cohere_chat/b', gateway: true });
    const { admin } = fakeAdmin([
      { id: 'sec-c', name: 'LiteLLM inst cohere' },
      { id: 'sec-c2', name: 'LiteLLM inst cohere 2' },
      { id: 'sec-cx', name: 'LiteLLM inst cohereplus' },
    ]);
    expect(await removeCloudModel('a', false, root, admin)).toEqual({
      removed: true,
      remaining: 1,
      leftGateway: false,
    });
    expect(admin.deleteSecret).not.toHaveBeenCalled();
    expect(await removeCloudModel('b', false, root, admin)).toEqual({ removed: true, remaining: 0, leftGateway: true });
    expect(vi.mocked(admin.deleteSecret).mock.calls.map((c) => c[0])).toEqual(['sec-c', 'sec-c2']);
  });

  it('with the last cloud model, the router leaves the gateway: proxy settings and router secret go', async () => {
    upsertBackend(root, { model_name: 'a', model: 'openai/a', gateway: true, provider: 'cohere' });
    upsertBackend(root, { model_name: 'local', model: 'openai/local', api_key_env: 'K' });
    const dir = path.join(root, 'data/litellm');
    for (const f of ['onecli.env', 'onecli-ca.pem']) fs.writeFileSync(path.join(dir, f), 'x');
    const { admin } = fakeAdmin([{ id: 'sec-r', name: 'LiteLLM inst router' }]);
    expect(await removeCloudModel('a', false, root, admin)).toEqual({ removed: true, remaining: 1, leftGateway: true });
    expect(fs.existsSync(path.join(dir, 'onecli.env'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'onecli-ca.pem'))).toBe(false);
    expect(admin.deleteSecret).toHaveBeenCalledWith('sec-r');
    expect(toolSecrets.reconcileAllAgents).toHaveBeenCalledWith(admin);
  });

  it('keeps a backend another registration still uses', async () => {
    upsertBackend(root, { model_name: 'a', model: 'cohere_chat/a', gateway: true });
    const { admin } = fakeAdmin();
    expect(await removeCloudModel('a', true, root, admin)).toEqual({ removed: false, remaining: 1 });
    expect(cloudModelNames(root)).toEqual(['a']);
  });
});

describe('cloudModelMaxOutput', () => {
  it("is the provider's cap for a cloud model the router serves, null for any other", () => {
    upsertBackend(root, { model_name: 'command-a-03-2025', model: 'cohere_chat/command-a-03-2025', gateway: true });
    expect(cloudModelMaxOutput('command-a-03-2025', 'http://127.0.0.1:4000/v1', root)).toBe(8192);
    expect(cloudModelMaxOutput('llama3', 'http://127.0.0.1:4000/v1', root)).toBeNull();
    // The same id on another server is not the cloud model.
    expect(cloudModelMaxOutput('command-a-03-2025', 'http://192.0.2.9:11434', root)).toBeNull();
  });
});

describe('the router behind the gateway', () => {
  const gatewayOn = () => {
    fs.mkdirSync(path.join(root, 'data/litellm'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/litellm/onecli.env'), 'HTTPS_PROXY=http://x:t@host.docker.internal:10255\n');
  };

  it('agents dial it by container name, once it serves a cloud model; other endpoints are untouched', () => {
    expect(agentRouterBase('http://127.0.0.1:4000/v1', root)).toBeNull();
    gatewayOn();
    expect(agentRouterBase('http://127.0.0.1:4000/v1', root)).toBe('http://nanoclaw-litellm:4000');
    expect(agentRouterBase('http://host.docker.internal:4000/v1', root)).toBe('http://nanoclaw-litellm:4000');
    expect(agentRouterBase('http://127.0.0.1:11434', root)).toBeNull();
    expect(agentRouterBase('https://llm.example.org:4000/v1', root)).toBeNull();
  });

  it('a registration made before the port changed is still the router, when asked', () => {
    expect(isRouterEndpoint('http://127.0.0.1:4001/v1', root)).toBe(false);
    expect(isRouterEndpoint('http://127.0.0.1:4001/v1', root, true)).toBe(true);
    expect(isRouterEndpoint('http://192.0.2.9:4001/v1', root, true)).toBe(false);
  });

  it("central's own loopback calls carry the master key; nothing else does", () => {
    fs.mkdirSync(path.join(root, 'data/litellm'), { recursive: true });
    expect(routerAuthHeaders('http://127.0.0.1:4000/v1/models', root)).toEqual({});
    fs.writeFileSync(path.join(root, 'data/litellm/master.key'), 'sk-abc');
    expect(routerAuthHeaders('http://127.0.0.1:4000/v1/models', root)).toEqual({ Authorization: 'Bearer sk-abc' });
    expect(routerAuthHeaders('http://127.0.0.1:11434/api/tags', root)).toEqual({});
    expect(routerAuthHeaders('http://host.docker.internal:4000/v1/models', root)).toEqual({});
  });

  it('names the router secrets, for the agents whose model the router serves (the source tool-secrets reads)', async () => {
    expect(toolSecrets.sources).toHaveLength(1);
    const source = toolSecrets.sources[0]!;
    const vault = [
      { id: 'sec-m', name: 'LiteLLM inst router messages' },
      { id: 'sec-o', name: 'LiteLLM inst router models' },
      { id: 'sec-c', name: 'LiteLLM inst cohere' },
      { id: 'sec-x', name: 'LiteLLM other router messages' },
    ];
    expect(await source.ids(fakeAdmin(vault).admin)).toEqual(['sec-m', 'sec-o']);
    groups.models.set('ag-cloud', { endpoint: 'http://127.0.0.1:4000/v1' });
    groups.models.set('ag-auto', { endpoint: 'http://host.docker.internal:4000' });
    groups.models.set('ag-named', { endpoint: 'http://nanoclaw-litellm:4000/v1' });
    groups.models.set('ag-ollama', { endpoint: 'http://127.0.0.1:11434' });
    groups.models.set('ag-claude', { endpoint: null });
    for (const id of ['ag-cloud', 'ag-auto', 'ag-named']) expect(await source.wants(id)).toBe(true);
    for (const id of ['ag-ollama', 'ag-claude', 'ag-none']) expect(await source.wants(id)).toBe(false);
    expect(await routerServesGroup('ag-cloud', root)).toBe(true);
  });

  it('at spawn, re-applies a group whose hold no longer matches its model, and leaves a matching one be', async () => {
    fs.mkdirSync(path.join(root, 'data/litellm'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/litellm/onecli.env'), 'HTTPS_PROXY=x\n');
    const vault = [
      { id: 'sec-m', name: 'LiteLLM inst router messages' },
      { id: 'sec-o', name: 'LiteLLM inst router models' },
    ];
    const { admin, assigned } = fakeAdmin(vault);
    // On a local model, holding the router's key: dropped.
    groups.models.set('ag-1', { endpoint: 'http://127.0.0.1:11434' });
    assigned.push('sec-m', 'sec-o');
    await syncRouterSecretHold('ag-1', admin, root);
    expect(toolSecrets.reconcileGroupAgents).toHaveBeenCalledWith(admin, 'ag-1');
    // On a cloud model, holding it: nothing to do.
    toolSecrets.reconcileGroupAgents.mockClear();
    groups.models.set('ag-1', { endpoint: 'http://127.0.0.1:4000/v1' });
    await syncRouterSecretHold('ag-1', admin, root);
    expect(toolSecrets.reconcileGroupAgents).not.toHaveBeenCalled();
    // A member's agent missing it while the group's model is the router's: re-applied.
    groups.members.set('ag-1', ['webchat:alice']);
    vi.mocked(admin.findAgentId).mockImplementation(async (ident) => (ident === 'ag-1' ? 'agent-1' : 'agent-alice'));
    vi.mocked(admin.listAgentSecretIds).mockImplementation(async (id) => (id === 'agent-1' ? ['sec-m', 'sec-o'] : []));
    await syncRouterSecretHold('ag-1', admin, root);
    expect(toolSecrets.reconcileGroupAgents).toHaveBeenCalledWith(admin, 'ag-1');
  });

  it('at spawn, does nothing when the router is not behind the gateway', async () => {
    const { admin } = fakeAdmin([{ id: 'sec-m', name: 'LiteLLM inst router messages' }]);
    groups.models.set('ag-1', { endpoint: 'http://127.0.0.1:11434' });
    await syncRouterSecretHold('ag-1', admin, root);
    expect(admin.listAllSecrets).not.toHaveBeenCalled();
    expect(toolSecrets.reconcileGroupAgents).not.toHaveBeenCalled();
  });

  it('replaces an older path-less router secret with the path-scoped ones', async () => {
    const { admin } = fakeAdmin([{ id: 'sec-old', name: 'LiteLLM inst router' }]);
    await prepareCloudModel({ provider: 'cohere', model_id: 'command-r', api_key: KEY }, root, {
      admin,
      containerConfig,
    });
    expect(admin.deleteSecret).toHaveBeenCalledWith('sec-old');
  });

  it("re-attaches OneCLI's container to the router's network, at most once a minute, and only with cloud models", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => void calls.push(args);
    await ensureRouterNetwork(root, run);
    expect(calls).toEqual([]);
    gatewayOn();
    await ensureRouterNetwork(root, run);
    await ensureRouterNetwork(root, run);
    expect(calls).toEqual([['network', 'connect', 'nanoclaw-litellm-gateway', 'onecli']]);
  });

  it('removing the router removes its secrets, every hold on them, its network and its identity', async () => {
    gatewayOn();
    const { admin } = fakeAdmin([
      { id: 'sec-m', name: 'LiteLLM inst router messages' },
      { id: 'sec-c', name: 'LiteLLM inst chat' },
    ]);
    const calls: string[][] = [];
    await removeRouter(root, admin, async (args) => void calls.push(args));
    expect(calls).toEqual([
      ['rm', '-f', 'nanoclaw-litellm'],
      ['network', 'disconnect', 'nanoclaw-litellm-gateway', 'onecli'],
      ['network', 'rm', 'nanoclaw-litellm-gateway'],
    ]);
    expect(admin.deleteSecret).toHaveBeenCalledWith('sec-m');
    expect(admin.deleteSecret).not.toHaveBeenCalledWith('sec-c');
    expect(toolSecrets.reconcileAllAgents).toHaveBeenCalledWith(admin);
    expect(fs.existsSync(path.join(root, 'data/litellm/onecli.env'))).toBe(false);
    expect(admin.deleteAgent).toHaveBeenCalledWith('agent-1');
  });
});
