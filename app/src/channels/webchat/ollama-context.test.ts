/**
 * The window Ollama actually serves: num_ctx when the model sets one, else
 * the loaded model's window, else Ollama's default — never more than the
 * architecture allows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearOllamaModelMetaCache,
  fetchOllamaModelMeta,
  parseOllamaPs,
  servedContextWindow,
  servedModelLimits,
} from './ollama-context.js';

const SHOW_NO_CTX = { parameters: 'stop "<|im_end|>"', model_info: { 'qwen3.context_length': 40960 } };
const PS_LOADED = { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 8192 }] };

function stubOllama(show: unknown, ps: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: URL | string) =>
    String(url).endsWith('/api/ps')
      ? new Response(JSON.stringify(ps), { status: 200 })
      : new Response(JSON.stringify(show), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => clearOllamaModelMetaCache());
afterEach(() => vi.unstubAllGlobals());

describe('the served window', () => {
  it("num_ctx from the model's parameters wins", () => {
    expect(servedContextWindow({ numCtx: 16384, loadedCtx: 8192, maxContext: 40960, vision: false })).toBe(16384);
  });

  it('without num_ctx, the loaded model’s window', () => {
    expect(servedContextWindow({ numCtx: null, loadedCtx: 8192, maxContext: 40960, vision: false })).toBe(8192);
  });

  it("neither: Ollama's default, 4096 — not a guess at what the model could take", () => {
    expect(servedModelLimits({ numCtx: null, loadedCtx: null, maxContext: 40960, vision: false })).toEqual({
      contextWindow: 4096,
      maxTokens: 1024,
    });
  });

  it("capped by the architecture's ceiling; output a quarter of the window, at most 8192", () => {
    expect(servedContextWindow({ numCtx: 65536, maxContext: 32768, vision: false })).toBe(32768);
    expect(servedModelLimits({ numCtx: 131072, maxContext: null, vision: false }).maxTokens).toBe(8192);
  });

  it('matches the loaded model by name, an untagged id as :latest', () => {
    expect(parseOllamaPs(PS_LOADED, 'qwen3:8b')).toBe(8192);
    expect(parseOllamaPs({ models: [{ name: 'llama3.2:latest', context_length: 2048 }] }, 'llama3.2')).toBe(2048);
    expect(parseOllamaPs(PS_LOADED, 'qwen3:4b')).toBeNull();
    expect(parseOllamaPs(null, 'qwen3:8b')).toBeNull();
  });
});

describe('asking the server', () => {
  it('reads /api/show and /api/ps, on loopback for the container alias', async () => {
    const fetchMock = stubOllama(SHOW_NO_CTX, PS_LOADED);
    const meta = await fetchOllamaModelMeta('http://host.docker.internal:11434/v1', 'qwen3:8b');
    expect(meta && servedContextWindow(meta)).toBe(8192);
    expect(fetchMock.mock.calls.map((c) => String(c[0])).sort()).toEqual([
      'http://127.0.0.1:11434/api/ps',
      'http://127.0.0.1:11434/api/show',
    ]);
  });

  it('a model that is not loaded, or a server without /api/ps, gets the default', async () => {
    stubOllama(SHOW_NO_CTX, { models: [] });
    const meta = await fetchOllamaModelMeta('http://192.0.2.9:11434', 'qwen3:8b');
    expect(meta && servedContextWindow(meta)).toBe(4096);
  });

  it('null when the server does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await fetchOllamaModelMeta('http://192.0.2.9:11434', 'qwen3:8b')).toBeNull();
  });
});
