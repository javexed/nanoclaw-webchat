import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effectiveModel = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
/** The agent's network mode and the model registry, for the relay to a model on another machine. */
const registry = vi.hoisted(() => ({
  egress: null as string | null,
  models: [] as Array<{ kind: string; endpoint: string | null }>,
}));

vi.mock('../channels/webchat/db.js', () => ({
  getEffectiveModelForAgent: vi.fn(async () => effectiveModel.value),
  listWebchatModels: async () => registry.models,
}));
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: async () => ({ egress: registry.egress }),
}));
// The profile store probes unknown models over the network in the background.
vi.mock('../model-profile-store.js', () => ({
  resolveWithBackgroundProbe: () => ({ turnTimeoutMs: 120_000, source: 'default' }),
}));

import { getEffectiveModelForAgent } from '../channels/webchat/db.js';
import { _resetHostHealthForTest, _setHostHealthForTest } from '../channels/webchat/model-host-health.js';
import { modelRelaysFor } from '../channels/webchat/model-relay.js';
import { parseOllamaShow } from '../channels/webchat/ollama-context.js';
import { _setWebchatBridgeLoaderForTest, clearPiModelMetaCache, piModelLimits } from './pi.js';
import { getProviderContainerConfig, type ProviderContainerContext } from './provider-container-registry.js';

let root: string;
let sessionDir: string;

function ctx(): ProviderContainerContext {
  return {
    sessionDir,
    agentGroupId: 'ag-1',
    groupDir: path.join(root, 'group'),
    selectedSkills: [],
    hostEnv: {},
  };
}

function wire(baseURL = 'http://host.docker.internal:11434/v1'): void {
  const shared = path.join(root, 'ag-1', '.claude-shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(
    path.join(shared, 'local-model.json'),
    JSON.stringify({ provider: 'ollama', model: 'ollama/qwen3:8b', baseURL }),
  );
}

/** Ollama answering /api/show with `body`, and /api/ps with `ps` (no model loaded by default). */
function stubShow(body: unknown, ps: unknown = { models: [] }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (url: URL | string) =>
      new Response(JSON.stringify(String(url).endsWith('/api/ps') ? ps : body), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function spawnConfig() {
  const fn = getProviderContainerConfig('pi');
  if (!fn) throw new Error('pi not registered');
  return fn(ctx());
}

function modelsJson(): { providers: Record<string, { models: Array<Record<string, unknown>> }> } {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'pi-agent', 'models.json'), 'utf-8'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-host-'));
  sessionDir = path.join(root, 'ag-1', 'sess-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  effectiveModel.value = null;
  registry.egress = null;
  registry.models = [];
  clearPiModelMetaCache();
  vi.mocked(getEffectiveModelForAgent).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pi host config — model limits', () => {
  it('declares the window Ollama runs the model with, and vision when it has it', async () => {
    wire();
    const fetchMock = stubShow({
      parameters: 'num_ctx                        16384\nstop "<|im_end|>"',
      model_info: { 'qwen3.context_length': 40960 },
      capabilities: ['completion', 'tools', 'vision'],
    });
    await spawnConfig();
    const [model] = modelsJson().providers.ollama.models;
    expect(model).toMatchObject({ id: 'qwen3:8b', contextWindow: 16384, maxTokens: 4096, input: ['text', 'image'] });
    // The host reaches the container's host.docker.internal on loopback.
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:11434/api/show');
    const settings = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pi-agent', 'settings.json'), 'utf-8'));
    expect(settings.compaction).toEqual({ reserveTokens: 4096, keepRecentTokens: 4096 });
  });

  it('falls back to 32768/8192, text only, when the server does not answer', async () => {
    wire();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await spawnConfig();
    expect(modelsJson().providers.ollama.models[0]).toMatchObject({
      contextWindow: 32768,
      maxTokens: 8192,
      input: ['text'],
    });
  });

  it('keeps other pi settings when it writes the compaction budget', async () => {
    wire();
    stubShow({});
    fs.mkdirSync(path.join(sessionDir, 'pi-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'pi-agent', 'settings.json'),
      JSON.stringify({ theme: 'dark', compaction: { enabled: true } }),
    );
    await spawnConfig();
    const settings = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pi-agent', 'settings.json'), 'utf-8'));
    expect(settings).toEqual({
      theme: 'dark',
      compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1024 },
    });
  });

  it('without num_ctx: the window the loaded model runs with, else Ollama’s default — not 32768', async () => {
    wire();
    const show = { parameters: 'stop "<|im_end|>"', model_info: { 'qwen3.context_length': 40960 } };
    stubShow(show, { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 8192 }] });
    await spawnConfig();
    expect(modelsJson().providers.ollama.models[0]).toMatchObject({ contextWindow: 8192, maxTokens: 2048 });

    clearPiModelMetaCache();
    stubShow(show);
    await spawnConfig();
    expect(modelsJson().providers.ollama.models[0]).toMatchObject({ contextWindow: 4096, maxTokens: 1024 });
    const settings = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pi-agent', 'settings.json'), 'utf-8'));
    expect(settings.compaction).toEqual({ reserveTokens: 1024, keepRecentTokens: 1024 });
  });

  it('caps the window at the architecture ceiling', async () => {
    expect(await piModelLimits({ numCtx: null, maxContext: 2048, vision: false })).toEqual({
      contextWindow: 2048,
      maxTokens: 512,
      input: ['text'],
    });
    expect(parseOllamaShow({ model_info: { 'llama.context_length': 131072 } })).toEqual({
      numCtx: null,
      maxContext: 131072,
      vision: false,
    });
  });
});

describe('pi host config — a model pi cannot serve', () => {
  it('flags an assigned cloud model instead of falling back to the .env model', async () => {
    stubShow({});
    effectiveModel.value = { name: 'Claude Sonnet', kind: 'anthropic', endpoint: null, model_id: 'claude-sonnet' };
    const res = await spawnConfig();
    expect(res.env?.PI_UNSERVABLE_MODEL).toBe('Claude Sonnet');
  });

  it('does not flag a wired local model, nor an agent with no model assigned', async () => {
    stubShow({});
    expect((await spawnConfig()).env?.PI_UNSERVABLE_MODEL).toBeUndefined();
    wire();
    effectiveModel.value = { name: 'Claude Sonnet', kind: 'anthropic', endpoint: null, model_id: 'claude-sonnet' };
    expect((await spawnConfig()).env?.PI_UNSERVABLE_MODEL).toBeUndefined();
  });
});

describe('pi host config — a model on another machine', () => {
  const LAN = 'http://192.0.2.9:11434/v1';
  beforeEach(() => {
    registry.models = [{ kind: 'ollama', endpoint: 'http://192.0.2.9:11434' }];
  });

  it('behind the egress filter (the default), pi dials the model through its relay on central', async () => {
    wire(LAN);
    const fetchMock = stubShow({ parameters: 'num_ctx 8192' });
    const res = await spawnConfig();
    const port = modelRelaysFor(registry.models)[0]!.port;
    expect(modelsJson().providers.ollama).toMatchObject({ baseUrl: `http://host.docker.internal:${port}/v1` });
    expect(res.env?.NO_PROXY?.split(',')).toContain('host.docker.internal');
    // The host itself asks the model server directly for its window.
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://192.0.2.9:11434/api/show');
  });

  it('on Open it dials the model directly, as before', async () => {
    registry.egress = 'open';
    wire(LAN);
    stubShow({ parameters: 'num_ctx 8192' });
    const res = await spawnConfig();
    expect(modelsJson().providers.ollama).toMatchObject({ baseUrl: LAN });
    expect(res.env?.NO_PROXY?.split(',')).toContain('192.0.2.9');
  });

  it("its host down and another serving the model: this spawn goes there, through that host's relay", async () => {
    const OTHER = 'http://192.0.2.10:11434';
    registry.models = [
      { kind: 'ollama', endpoint: 'http://192.0.2.9:11434' },
      { kind: 'ollama', endpoint: OTHER },
    ];
    effectiveModel.value = { kind: 'ollama', endpoint: 'http://192.0.2.9:11434', model_id: 'qwen3:8b' };
    _setHostHealthForTest('http://192.0.2.9:11434', { status: 'down' });
    _setHostHealthForTest(OTHER, { status: 'up', models: ['qwen3:8b-ctx12k'] });
    try {
      wire(LAN);
      const fetchMock = stubShow({ parameters: 'num_ctx 12288' });
      await spawnConfig();
      const port = modelRelaysFor(registry.models).find((r) => r.target.host === '192.0.2.10')!.port;
      expect(modelsJson().providers.ollama).toMatchObject({
        baseUrl: `http://host.docker.internal:${port}/v1`,
        models: [expect.objectContaining({ id: 'qwen3:8b-ctx12k', contextWindow: 12288 })],
      });
      expect(String(fetchMock.mock.calls[0][0])).toBe(`${OTHER}/api/show`);
    } finally {
      _resetHostHealthForTest();
    }
  });
});

describe('pi host config — an install without webchat', () => {
  beforeEach(() => {
    _setWebchatBridgeLoaderForTest(async () => null);
  });
  afterEach(() => {
    _setWebchatBridgeLoaderForTest();
  });

  it('runs on the .env model with the default window, asking no model bridge', async () => {
    const fetchMock = stubShow({ parameters: 'num_ctx 16384' });
    const fn = getProviderContainerConfig('pi')!;
    const res = await fn({
      ...ctx(),
      hostEnv: { PI_MODEL: 'qwen3:4b', ANTHROPIC_BASE_URL: 'http://192.0.2.9:11434/v1' },
    });
    expect(modelsJson().providers.ollama).toMatchObject({
      baseUrl: 'http://192.0.2.9:11434/v1',
      models: [expect.objectContaining({ id: 'qwen3:4b', contextWindow: 32768, maxTokens: 8192 })],
    });
    expect(res.env?.PI_MODEL).toBe('qwen3:4b');
    expect(res.env?.PI_UNSERVABLE_MODEL).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getEffectiveModelForAgent).not.toHaveBeenCalled();
  });
});
