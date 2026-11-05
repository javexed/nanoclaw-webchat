import { describe, expect, it } from 'vitest';

import { normalizeOllamaModelName, sameOllamaModel } from './ollama-names.js';

describe('Ollama model names', () => {
  it('spells a tag as the server does', () => {
    expect(normalizeOllamaModelName('  Llama3.2:3B ')).toBe('llama3.2:3b');
  });

  it('matches a mixed-case tag to the server spelling, with or without :latest', () => {
    expect(sameOllamaModel('llama3.2', 'Llama3.2')).toBe(true);
    expect(sameOllamaModel('llama3.2:latest', 'Llama3.2')).toBe(true);
    expect(sameOllamaModel('qwen3:8b', 'Llama3.2')).toBe(false);
  });
});
