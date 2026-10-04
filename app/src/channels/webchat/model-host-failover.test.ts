/**
 * An agent's Ollama host is down and another registered host serves the same
 * model: the next spawn goes there — through that host's relay when the agent
 * is behind the egress filter, and admitted by it — without touching the
 * assignment. Against the real central DB.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  get DATA_DIR() {
    return env.dataDir;
  },
}));

import { closeDb, initDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { assignModelToAgent, createWebchatModel, getAssignedModelForAgent } from './db.js';
import { __resetRunnerEgressForTest, forgetModelHosts, ownModelTargetsFor } from './egress-policy.js';
import {
  _resetHostHealthForTest,
  _setHostHealthForTest,
  baseModelRef,
  checkHosts,
  failoverTarget,
  hostHealthSnapshot,
  localModelFailover,
  type HostHealth,
} from './model-host-health.js';
import { modelRelays } from './model-relay.js';
import { refreshRemoteModelSettings, writeAgentSettingsForAssignedModel } from './models.js';

const GROUP = 'ag-1';
const A = 'http://192.0.2.9:11434';
const B = 'http://192.0.2.10:11434';
let settingsPath: string;

const up = (models: string[]): Partial<HostHealth> & { status: 'up' } => ({ status: 'up', models, registered: true });

async function addModel(id: string, endpoint: string, modelId: string): Promise<void> {
  await createWebchatModel({
    id,
    name: id,
    kind: 'ollama',
    endpoint,
    model_id: modelId,
    credential_ref: null,
    created_at: Date.now(),
  });
}

beforeEach(async () => {
  env.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-failover-'));
  await initDb(path.join(env.dataDir, 'test.db'));
  await runMigrations(getDb());
  await getDb().run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?,?,?,NULL,'t')`,
    GROUP,
    GROUP,
    GROUP,
  );
  await addModel('a', A, 'qwen3:8b');
  await addModel('b', B, 'qwen3:8b');
  await assignModelToAgent(GROUP, 'a');
  const dir = path.join(env.dataDir, 'v2-sessions', GROUP, '.claude-shared');
  fs.mkdirSync(dir, { recursive: true });
  settingsPath = path.join(dir, 'settings.json');
  _resetHostHealthForTest();
  __resetRunnerEgressForTest();
});

afterEach(async () => {
  _resetHostHealthForTest();
  await closeDb();
  fs.rmSync(env.dataDir, { recursive: true, force: true });
});

const settingsEnv = (): Record<string, string> =>
  (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }).env;
const relayPort = async (endpoint: string): Promise<number> =>
  (await modelRelays()).find((r) => `http://${r.target.host}:${r.target.port}` === endpoint)!.port;

describe('failoverTarget', () => {
  const model = { kind: 'ollama' as const, endpoint: A, model_id: 'qwen3:8b' };

  it('the same model on another host that is up', () => {
    expect(
      failoverTarget(model, { [A]: { ...up([]), status: 'down' } as HostHealth, [B]: up(['qwen3:8b']) as HostHealth }),
    ).toEqual({
      endpoint: B,
      model_id: 'qwen3:8b',
    });
  });

  it('else a context variant of it, the largest window first', () => {
    const state = {
      [A]: { ...up([]), status: 'down' } as HostHealth,
      [B]: up(['qwen3:8b-ctx8k', 'qwen3:8b-ctx12k', 'llama3.2:latest']) as HostHealth,
    };
    expect(failoverTarget(model, state)).toEqual({ endpoint: B, model_id: 'qwen3:8b-ctx12k' });
    expect(failoverTarget({ ...model, model_id: 'qwen3:8b-ctx16k' }, state)?.model_id).toBe('qwen3:8b-ctx12k');
  });

  it('nothing while the own host is up or unknown, or no other host serves it', () => {
    expect(failoverTarget(model, { [A]: up([]) as HostHealth, [B]: up(['qwen3:8b']) as HostHealth })).toBeNull();
    expect(failoverTarget(model, { [B]: up(['qwen3:8b']) as HostHealth })).toBeNull();
    expect(
      failoverTarget(model, { [A]: { ...up([]), status: 'down' } as HostHealth, [B]: up(['gemma3:4b']) as HostHealth }),
    ).toBeNull();
    // A host only probed (the classifier's), not registered, is never a target.
    expect(
      failoverTarget(model, {
        [A]: { ...up([]), status: 'down' } as HostHealth,
        [B]: { ...up(['qwen3:8b']), registered: false } as HostHealth,
      }),
    ).toBeNull();
  });

  it('a variant name maps back to its base model', () => {
    expect(baseModelRef('qwen3:8b-ctx12k')).toBe('qwen3:8b');
    expect(baseModelRef('llama3.2-ctx8k:latest')).toBe('llama3.2');
  });
});

describe('checkHosts', () => {
  it('records up and down with the last answer, and reports changes', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith(A)) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 });
    });
    expect(await checkHosts([A, B], fetchImpl, 1000)).toEqual([A, B].sort());
    expect(await checkHosts([A, B], fetchImpl, 2000)).toEqual([]);
    expect(hostHealthSnapshot()[B]).toMatchObject({ status: 'up', lastOk: 2000, models: ['qwen3:8b'] });
    expect(hostHealthSnapshot()[A]).toMatchObject({ status: 'down', lastOk: null, lastError: 'fetch failed' });
    expect(fetchImpl).toHaveBeenCalledWith(`${B}/api/tags`, expect.anything());
  });
});

describe('the next spawn on a down host', () => {
  it('goes to the other host through its relay, and the relay admits the agent', async () => {
    _setHostHealthForTest(A, { status: 'down' });
    _setHostHealthForTest(B, up(['qwen3:8b']));
    await refreshRemoteModelSettings(GROUP);
    expect(settingsEnv().ANTHROPIC_BASE_URL).toBe(`http://host.docker.internal:${await relayPort(B)}`);
    expect(await ownModelTargetsFor(GROUP)).toEqual(['192.0.2.9:11434', '192.0.2.10:11434']);
    // The assignment itself is untouched.
    expect((await getAssignedModelForAgent(GROUP))?.id).toBe('a');
  });

  it('an Open agent dials the other host directly, past the proxy', async () => {
    await ensureContainerConfig(GROUP);
    await updateContainerConfigScalars(GROUP, { egress: 'open' });
    _setHostHealthForTest(A, { status: 'down' });
    _setHostHealthForTest(B, up(['qwen3:8b-ctx12k']));
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv()).toMatchObject({
      ANTHROPIC_BASE_URL: B,
      ANTHROPIC_MODEL: 'qwen3:8b-ctx12k',
      NO_PROXY: '192.0.2.10',
    });
  });

  it('is back on its own host once that answers again', async () => {
    await ensureContainerConfig(GROUP);
    await updateContainerConfigScalars(GROUP, { egress: 'open' });
    _setHostHealthForTest(A, { status: 'down' });
    _setHostHealthForTest(B, up(['qwen3:8b']));
    await refreshRemoteModelSettings(GROUP);
    expect(settingsEnv().ANTHROPIC_BASE_URL).toBe(B);
    _setHostHealthForTest(A, up(['qwen3:8b']));
    forgetModelHosts();
    await refreshRemoteModelSettings(GROUP);
    expect(settingsEnv().ANTHROPIC_BASE_URL).toBe(A);
    expect(await ownModelTargetsFor(GROUP)).toEqual(['192.0.2.9:11434']);
  });

  it('a host-local model is rewritten at spawn too, and put back after', async () => {
    await addModel('local', 'http://localhost:11434', 'qwen3:8b');
    await assignModelToAgent(GROUP, 'local');
    await ensureContainerConfig(GROUP);
    await updateContainerConfigScalars(GROUP, { egress: 'open' });
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv().ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:11434');
    _setHostHealthForTest('http://localhost:11434', { status: 'down' });
    _setHostHealthForTest(B, up(['qwen3:8b']));
    await refreshRemoteModelSettings(GROUP);
    expect(settingsEnv().ANTHROPIC_BASE_URL).toBe(B);
    _setHostHealthForTest('http://localhost:11434', up(['qwen3:8b']));
    await refreshRemoteModelSettings(GROUP);
    expect(settingsEnv().ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:11434');
  });

  it('a host-local model is put back after a host restart forgot the move', async () => {
    await addModel('local', 'http://localhost:11434', 'qwen3:8b');
    await assignModelToAgent(GROUP, 'local');
    await ensureContainerConfig(GROUP);
    await updateContainerConfigScalars(GROUP, { egress: 'open' });
    _setHostHealthForTest('http://localhost:11434', { status: 'down' });
    _setHostHealthForTest(B, up(['qwen3:8b']));
    await refreshRemoteModelSettings(GROUP);
    expect(settingsEnv().ANTHROPIC_BASE_URL).toBe(B);
    // A host restart: health and the record of the move are gone, settings.json is not.
    _resetHostHealthForTest();
    await refreshRemoteModelSettings(GROUP);
    expect(settingsEnv()).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_MODEL: 'qwen3:8b',
    });
  });

  it('settings already naming the right model are not rewritten at spawn', async () => {
    await addModel('local', 'http://localhost:11434', 'qwen3:8b');
    await assignModelToAgent(GROUP, 'local');
    await writeAgentSettingsForAssignedModel(GROUP);
    const before = fs.statSync(settingsPath).mtimeMs;
    fs.utimesSync(settingsPath, 1, 1);
    await refreshRemoteModelSettings(GROUP);
    expect(fs.statSync(settingsPath).mtimeMs).toBe(1000);
    expect(before).toBeGreaterThan(1000);
  });

  it("pi's model is moved the same way", async () => {
    expect(await localModelFailover(GROUP)).toBeNull();
    _setHostHealthForTest(A, { status: 'down' });
    _setHostHealthForTest(B, up(['qwen3:8b']));
    expect(await localModelFailover(GROUP)).toEqual({ baseURL: `${B}/v1`, modelId: 'qwen3:8b' });
  });
});
