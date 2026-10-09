/**
 * Which harness runs which model. Claude Code under another vendor's model told
 * the user it was Claude Sonnet (its own system prompt says so), so the Claude
 * harness is for Anthropic models; local and cloud models default to OpenCode
 * (pi for local), and Codex and Grok bring their own model.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

// A cloud model is one the router serves (cloud-models.ts); here, only 'command-a'.
vi.mock('./cloud-models.js', () => ({
  cloudModelMaxOutput: (id: string) => (id === 'command-a' ? 8192 : null),
  agentRouterBase: () => null,
  routerAuthHeaders: () => ({}),
}));

import { registerProviderContainerConfig } from '../../providers/provider-container-registry.js';
import { harnessFits, harnessSwitchRefusal, providerForModel } from './models.js';

const cloud = {
  kind: 'openai-compatible',
  endpoint: 'http://127.0.0.1:4000/v1',
  model_id: 'command-a',
  name: 'Cohere command-a',
} as const;
const routing = {
  kind: 'openai-compatible',
  endpoint: 'http://127.0.0.1:4000/v1',
  model_id: 'auto',
  name: 'Auto',
} as const;
const local = { kind: 'ollama', endpoint: 'http://localhost:11434', model_id: 'qwen3:8b', name: 'qwen3:8b' } as const;
const anthropic = { kind: 'anthropic', endpoint: null, model_id: 'claude-sonnet-5', name: 'Sonnet' } as const;

// Order matters: the registry is a process singleton with no unregister.
describe('with no local harness installed', () => {
  it('keeps every model on Claude, which stays the fallback that runs them', () => {
    expect(providerForModel(cloud)).toBeNull();
    expect(providerForModel(local)).toBeNull();
    expect(harnessFits('claude', cloud)).toBe(true);
    expect(harnessSwitchRefusal('claude', cloud)).toBeNull();
  });
});

describe('with OpenCode installed', () => {
  beforeAll(() => registerProviderContainerConfig('opencode', () => ({ env: {} })));

  it('defaults local and cloud models to OpenCode; Anthropic and the routing model stay on Claude', () => {
    expect(providerForModel(cloud)).toBe('opencode');
    expect(providerForModel(local)).toBe('opencode');
    expect(providerForModel(anthropic)).toBeNull();
    expect(providerForModel(routing)).toBeNull();
    expect(providerForModel(null)).toBeNull();
  });

  it('refuses Claude for a model OpenCode can run, and says why', () => {
    expect(harnessFits('claude', cloud)).toBe(false);
    expect(harnessSwitchRefusal('claude', cloud)).toBe(
      "Claude runs Anthropic models only, and this agent's model is Cohere command-a",
    );
    expect(harnessFits('claude', anthropic)).toBe(true);
    expect(harnessFits('claude', routing)).toBe(true);
    expect(harnessFits(null, null)).toBe(true);
  });

  it('OpenCode runs local and cloud models, not an Anthropic or routing one', () => {
    expect(harnessFits('opencode', cloud)).toBe(true);
    expect(harnessFits('opencode', local)).toBe(true);
    expect(harnessFits('opencode', anthropic)).toBe(false);
    expect(harnessFits('opencode', routing)).toBe(false);
  });

  it('Codex and Grok take no registry model, and switching to them is never refused', () => {
    for (const h of ['codex', 'grok']) {
      expect(harnessFits(h, cloud)).toBe(false);
      expect(harnessFits(h, null)).toBe(true);
      expect(harnessSwitchRefusal(h, cloud)).toBeNull();
    }
  });
});

describe('with pi installed too', () => {
  beforeAll(() => registerProviderContainerConfig('pi', () => ({ env: {} })));

  it('pi takes local models first; a cloud model still goes to OpenCode', () => {
    expect(providerForModel(local)).toBe('pi');
    expect(providerForModel(cloud)).toBe('opencode');
    expect(harnessFits('pi', cloud)).toBe(false);
    expect(harnessSwitchRefusal('pi', cloud)).toBe(
      "pi runs local models only, and this agent's model is Cohere command-a",
    );
  });
});
