/**
 * envForModel: an Ollama model's ANTHROPIC_BASE_URL must be the BARE endpoint.
 * The Anthropic SDK appends the full `/v1/messages` path itself; appending `/v1`
 * here makes it hit `<endpoint>/v1/v1/messages` → 404 ("model may not exist").
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

// A cloud model is one the router serves (cloud-models.ts); here, only 'command-a'.
// The router (port 4000 here) is behind the gateway only when a test says so.
const router = vi.hoisted(() => ({ viaGateway: false }));
vi.mock('./cloud-models.js', () => ({
  cloudModelMaxOutput: (id: string) => (id === 'command-a' ? 8192 : null),
  agentRouterBase: (endpoint: string | null) =>
    router.viaGateway && /:4000(\/|$)/.test(endpoint ?? '') ? 'http://nanoclaw-litellm:4000' : null,
  routerAuthHeaders: () => ({}),
}));

import { envForModel, openCodeBackendEnv } from './models.js';

describe('envForModel — ollama base URL', () => {
  it('points ANTHROPIC_BASE_URL at the bare endpoint (no /v1 append)', async () => {
    const env = envForModel({
      kind: 'ollama',
      endpoint: 'http://192.0.2.127:11434',
      model_id: 'llama3.2:3b',
    } as never);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://192.0.2.127:11434');
    expect(env.ANTHROPIC_MODEL).toBe('llama3.2:3b');
    // Must bypass the OneCLI credential proxy — it only fronts known providers
    // and RESETs redirected Ollama calls (docs/ollama.md). Regression guard.
    expect(env.NO_PROXY).toBe('192.0.2.127');
    expect(env.no_proxy).toBe('192.0.2.127');
  });

  it('strips a trailing slash but still does not append /v1', async () => {
    const env = envForModel({ kind: 'ollama', endpoint: 'http://host:11434/', model_id: 'm' } as never);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://host:11434');
  });
});

/**
 * openCodeBackendEnv: the install-wide keys upstream's OpenCode provider reads.
 * The model is the one picked in webchat — never a fixed id — and the SMALL
 * model is the same one, or OpenCode's side tasks ask a local endpoint for its
 * built-in gpt-5.4-nano.
 */
describe('openCodeBackendEnv — the picked model reaches the harness', () => {
  it('maps an Ollama model to the openai provider at /v1, reachable from the container', () => {
    const b = openCodeBackendEnv({
      kind: 'ollama',
      endpoint: 'http://localhost:11434',
      model_id: 'qwen3:8b',
    } as never)!;
    expect(b.env).toEqual({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: 'http://host.docker.internal:11434/v1',
      OPENCODE_MODEL: 'openai/qwen3:8b',
      OPENCODE_SMALL_MODEL: 'openai/qwen3:8b',
    });
    expect(b.proxyHost).toBe('host.docker.internal');
  });

  it('does not double a /v1 the registry endpoint already carries', () => {
    const b = openCodeBackendEnv({ kind: 'ollama', endpoint: 'http://192.0.2.9:11434/v1/', model_id: 'm' } as never)!;
    expect(b.env.OPENCODE_BASE_URL).toBe('http://192.0.2.9:11434/v1');
    expect(b.proxyHost).toBe('192.0.2.9');
  });

  it('is null for a non-Ollama kind or a model without an endpoint', () => {
    expect(openCodeBackendEnv({ kind: 'anthropic', endpoint: null, model_id: 'claude' } as never)).toBeNull();
    expect(
      openCodeBackendEnv({ kind: 'openai-compatible', endpoint: 'http://r:4000/v1', model_id: 'm' } as never),
    ).toBeNull();
    expect(openCodeBackendEnv({ kind: 'ollama', endpoint: null, model_id: 'm' } as never)).toBeNull();
  });

  it('maps a cloud model to the router at /v1, with its provider cap', () => {
    const b = openCodeBackendEnv({
      kind: 'openai-compatible',
      endpoint: 'http://127.0.0.1:4001/v1',
      model_id: 'command-a',
    } as never)!;
    expect(b.env).toEqual({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: 'http://host.docker.internal:4001/v1',
      OPENCODE_MODEL: 'openai/command-a',
      OPENCODE_SMALL_MODEL: 'openai/command-a',
      OPENCODE_MODEL_OUTPUT_LIMIT: '8192',
    });
  });
});

describe('the router behind the gateway', () => {
  afterEach(() => void (router.viaGateway = false));
  const cloud = { kind: 'openai-compatible', endpoint: 'http://127.0.0.1:4000/v1', model_id: 'command-a' } as never;

  it('Claude Code dials it by container name through the gateway: no NO_PROXY bypass', () => {
    router.viaGateway = true;
    expect(envForModel(cloud)).toEqual({
      ANTHROPIC_BASE_URL: 'http://nanoclaw-litellm:4000',
      ANTHROPIC_MODEL: 'command-a',
      // A pinned alias (a runner's "sonnet") and the background calls land on it too.
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'command-a',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'command-a',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'command-a',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
    });
  });

  it('OpenCode too, and adds nothing to NO_PROXY', () => {
    router.viaGateway = true;
    const b = openCodeBackendEnv(cloud)!;
    expect(b.env.OPENCODE_BASE_URL).toBe('http://nanoclaw-litellm:4000/v1');
    expect(b.proxyHost).toBeNull();
  });

  it('directly, with the bypass, while it serves no cloud model', () => {
    expect(envForModel(cloud).ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:4000');
    expect(envForModel(cloud).NO_PROXY).toBe('host.docker.internal');
  });
});

/**
 * Host↔container URL translation. The env block is container-facing: a
 * loopback endpoint (the operator's host-side view) must become the
 * in-container host-gateway alias, or the container calls itself. The
 * reverse mapping lets safeFetch (probe / save-validation, which run on the
 * host) accept an endpoint pasted in container form.
 */
import { containerReachableUrl, hostReachableUrl } from './models.js';

describe('envForModel — container-facing URL rewrite', () => {
  it('rewrites loopback to host.docker.internal for openai-compatible models', async () => {
    const env = envForModel({
      kind: 'openai-compatible',
      endpoint: 'http://127.0.0.1:4000/v1',
      model_id: 'gemma4:latest',
    } as never);
    // Direct path: Anthropic-spec vars, trailing /v1 stripped (the SDK appends
    // the full /v1/messages path; LiteLLM serves it at the root, like Ollama).
    expect(env.ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:4000');
    expect(env.ANTHROPIC_MODEL).toBe('gemma4:latest');
    expect(env.NO_PROXY).toBe('host.docker.internal');
  });

  it('rewrites localhost for ollama models; LAN hosts pass through', async () => {
    expect(
      envForModel({ kind: 'ollama', endpoint: 'http://localhost:11434', model_id: 'm' } as never).ANTHROPIC_BASE_URL,
    ).toBe('http://host.docker.internal:11434');
    expect(
      envForModel({ kind: 'ollama', endpoint: 'http://192.0.2.90:11434', model_id: 'm' } as never).ANTHROPIC_BASE_URL,
    ).toBe('http://192.0.2.90:11434');
  });

  it('is anchored — a hostname merely containing localhost is untouched', async () => {
    expect(containerReachableUrl('http://localhost.evil.com:4000')).toBe('http://localhost.evil.com:4000');
  });
});

describe('hostReachableUrl', () => {
  it('maps the container-only alias to loopback and leaves everything else', async () => {
    expect(hostReachableUrl('http://host.docker.internal:4000/v1')).toBe('http://127.0.0.1:4000/v1');
    expect(hostReachableUrl('http://host.docker.internal.evil.com')).toBe('http://host.docker.internal.evil.com');
    expect(hostReachableUrl('http://192.0.2.90:11434')).toBe('http://192.0.2.90:11434');
  });
});
