import { describe, expect, it } from 'vitest';

import { harnessFields, harnessRuns } from './harness-fit.js';

const cloud = new Set(['command-a']);
const cohere = { kind: 'openai-compatible', model_id: 'command-a' };
const auto = { kind: 'openai-compatible', model_id: 'auto' };
const qwen = { kind: 'ollama', model_id: 'qwen3:8b' };
const sonnet = { kind: 'anthropic', model_id: 'claude-sonnet-5' };

describe('harnessRuns', () => {
  it('Claude: Anthropic models and the routing model, not a cloud or local one', () => {
    expect(harnessRuns('claude', sonnet, cloud)).toBe(true);
    expect(harnessRuns('claude', auto, cloud)).toBe(true);
    expect(harnessRuns('claude', cohere, cloud)).toBe(false);
    expect(harnessRuns('claude', qwen, cloud)).toBe(false);
  });

  it('OpenCode: local and cloud; pi: local only', () => {
    expect(harnessRuns('opencode', cohere, cloud)).toBe(true);
    expect(harnessRuns('opencode', qwen, cloud)).toBe(true);
    expect(harnessRuns('opencode', sonnet, cloud)).toBe(false);
    expect(harnessRuns('pi', qwen, cloud)).toBe(true);
    expect(harnessRuns('pi', cohere, cloud)).toBe(false);
  });

  it('Codex and Grok ignore the registry model; no model fits anything', () => {
    expect(harnessRuns('codex', cohere, cloud)).toBe(true);
    expect(harnessRuns('grok', sonnet, cloud)).toBe(true);
    expect(harnessRuns('claude', null, cloud)).toBe(true);
  });
});

describe('harnessFields', () => {
  it('Codex and Grok drop the registry picker for their own model field', () => {
    expect(harnessFields('grok')).toEqual({
      picker: false,
      pin: true,
      pinLabel: 'Grok model',
      pinSuggestions: ['grok-4.6', 'grok-4.5'],
    });
    expect(harnessFields('codex')).toMatchObject({ picker: false, pin: true, pinLabel: 'Codex model' });
  });

  it('Claude keeps both; OpenCode and pi the picker only (their model field is written for them)', () => {
    expect(harnessFields(null)).toMatchObject({ picker: true, pin: true, pinLabel: 'Anthropic model' });
    expect(harnessFields('opencode')).toMatchObject({ picker: true, pin: false });
    expect(harnessFields('pi')).toMatchObject({ picker: true, pin: false });
  });
});
