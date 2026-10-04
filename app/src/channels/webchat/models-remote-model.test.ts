/**
 * A model on another machine (a LAN GPU box), end to end against the real
 * central DB: the Claude settings and the OpenCode env an agent starts with.
 * Behind the egress filter (any mode but Open) the model URL names its relay
 * on central; on Open it stays direct. OpenCode is also told the window
 * Ollama actually serves.
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
vi.mock('../../env.js', async (orig) => ({
  ...(await orig<typeof import('../../env.js')>()),
  readEnvFile: () => ({}),
}));

import { closeDb, initDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { assignModelToAgent, createWebchatModel } from './db.js';
import { modelRelays } from './model-relay.js';
import { openCodeSpawnEnv, refreshRemoteModelSettings, writeAgentSettingsForAssignedModel } from './models.js';
import { clearOllamaModelMetaCache } from './ollama-context.js';

const GROUP = 'ag-1';
const LAN = 'http://192.0.2.9:11434';
let settingsPath: string;
let relayPort: number;

async function setEgress(egress: string | null): Promise<void> {
  await ensureContainerConfig(GROUP);
  await updateContainerConfigScalars(GROUP, { egress });
}

beforeEach(async () => {
  env.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-remote-model-'));
  await initDb(path.join(env.dataDir, 'test.db'));
  await runMigrations(getDb());
  await getDb().run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?,?,?,NULL,'t')`,
    GROUP,
    GROUP,
    GROUP,
  );
  await createWebchatModel({
    id: 'lan',
    name: 'lan',
    kind: 'ollama',
    endpoint: LAN,
    model_id: 'qwen3:8b',
    credential_ref: null,
    created_at: Date.now(),
  });
  await assignModelToAgent(GROUP, 'lan');
  relayPort = (await modelRelays())[0]!.port;
  const dir = path.join(env.dataDir, 'v2-sessions', GROUP, '.claude-shared');
  fs.mkdirSync(dir, { recursive: true });
  settingsPath = path.join(dir, 'settings.json');
  clearOllamaModelMetaCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(env.dataDir, { recursive: true, force: true });
});

const settingsEnv = (): Record<string, string> =>
  (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }).env;

describe('Claude on a model on another machine', () => {
  it('a new agent (no mode set: behind the filter) dials the relay, past the proxy', async () => {
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv()).toMatchObject({
      ANTHROPIC_BASE_URL: `http://host.docker.internal:${relayPort}`,
      NO_PROXY: 'host.docker.internal',
      no_proxy: 'host.docker.internal',
    });
  });

  it('model only reaches its model the same way', async () => {
    await setEgress('none');
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv().ANTHROPIC_BASE_URL).toBe(`http://host.docker.internal:${relayPort}`);
  });

  it('an Open agent dials the model directly, as before', async () => {
    await setEgress('open');
    await writeAgentSettingsForAssignedModel(GROUP);
    expect(settingsEnv()).toMatchObject({ ANTHROPIC_BASE_URL: LAN, NO_PROXY: '192.0.2.9' });
  });

  it('follows a change of mode at the next spawn', async () => {
    await setEgress('open');
    await writeAgentSettingsForAssignedModel(GROUP);
    await setEgress('host-only');
    await refreshRemoteModelSettings(GROUP);
    expect(settingsEnv().ANTHROPIC_BASE_URL).toBe(`http://host.docker.internal:${relayPort}`);
  });
});

describe('OpenCode on a model on another machine', () => {
  function stubOllama(show: unknown, ps: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: URL | string) =>
          new Response(JSON.stringify(String(url).endsWith('/api/ps') ? ps : show), { status: 200 }),
      ),
    );
  }
  const SHOW = { parameters: 'stop "<|im_end|>"', model_info: { 'qwen3.context_length': 40960 } };

  beforeEach(async () => {
    await ensureContainerConfig(GROUP);
    await updateContainerConfigScalars(GROUP, { provider: 'opencode' });
  });

  it('behind the filter: the relay, exempt from the proxy, and the window Ollama serves', async () => {
    stubOllama(SHOW, { models: [] });
    const out = await openCodeSpawnEnv(GROUP);
    expect(out).toMatchObject({
      OPENCODE_BASE_URL: `http://host.docker.internal:${relayPort}/v1`,
      OPENCODE_MODEL_CONTEXT_LIMIT: '4096',
      OPENCODE_MODEL_OUTPUT_LIMIT: '1024',
    });
    expect(out.NO_PROXY.split(',')).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost', 'host.docker.internal']));
  });

  it('on Open: no URL override, only the served window (here the loaded one)', async () => {
    await updateContainerConfigScalars(GROUP, { egress: 'open' });
    stubOllama(SHOW, { models: [{ name: 'qwen3:8b', context_length: 16384 }] });
    expect(await openCodeSpawnEnv(GROUP)).toEqual({
      OPENCODE_MODEL_CONTEXT_LIMIT: '16384',
      OPENCODE_MODEL_OUTPUT_LIMIT: '4096',
    });
  });

  it("replaces the default limits the install wrote, never an operator's own", async () => {
    await updateContainerConfigScalars(GROUP, { egress: 'open' });
    stubOllama({ ...SHOW, parameters: 'num_ctx 8192' }, { models: [] });
    vi.stubEnv('OPENCODE_MODEL_CONTEXT_LIMIT', '32768');
    vi.stubEnv('OPENCODE_MODEL_OUTPUT_LIMIT', '8192');
    expect(await openCodeSpawnEnv(GROUP)).toMatchObject({ OPENCODE_MODEL_CONTEXT_LIMIT: '8192' });
    clearOllamaModelMetaCache();
    vi.stubEnv('OPENCODE_MODEL_CONTEXT_LIMIT', '65536');
    expect(await openCodeSpawnEnv(GROUP)).toEqual({});
  });

  it('nothing for an agent on another provider', async () => {
    await updateContainerConfigScalars(GROUP, { provider: 'claude' });
    stubOllama(SHOW, { models: [] });
    expect(await openCodeSpawnEnv(GROUP)).toEqual({});
  });
});
