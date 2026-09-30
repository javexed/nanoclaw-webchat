/**
 * The spawn path reads the lenient answer before its prepare hooks run, so it
 * must be current when a spawn starts — not one spawn behind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = new Map<string, { kind: string } | null>();
vi.mock('./db.js', () => ({ getEffectiveModelForAgent: async (id: string) => models.get(id) ?? null }));
vi.mock('../../db/agent-groups.js', () => ({
  getAllAgentGroups: async () => [{ id: 'ag-ollama' }, { id: 'ag-claude' }],
}));
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));

import {
  __resetOllamaLenientForTest,
  isOllamaLenient,
  primeOllamaLenient,
  refreshOllamaLenient,
} from './ollama-lenient.js';

beforeEach(() => {
  __resetOllamaLenientForTest();
  models.clear();
});

describe('ollama lenient cache', () => {
  it('is primed for every group, so the first spawn after a restart is right', async () => {
    models.set('ag-ollama', { kind: 'ollama' });
    models.set('ag-claude', { kind: 'anthropic' });
    await primeOllamaLenient();
    expect(isOllamaLenient('ag-ollama')).toBe(true);
    expect(isOllamaLenient('ag-claude')).toBe(false);
  });

  it('follows a model change as soon as it is refreshed, with no spawn in between', async () => {
    models.set('ag-claude', { kind: 'anthropic' });
    await refreshOllamaLenient('ag-claude');
    expect(isOllamaLenient('ag-claude')).toBe(false);
    models.set('ag-claude', { kind: 'ollama' });
    await refreshOllamaLenient('ag-claude');
    expect(isOllamaLenient('ag-claude')).toBe(true);
  });

  it('keeps the previous answer when the model cannot be read', async () => {
    models.set('ag-ollama', { kind: 'ollama' });
    await refreshOllamaLenient('ag-ollama');
    models.set('ag-ollama', {
      get kind(): string {
        throw new Error('db gone');
      },
    });
    await refreshOllamaLenient('ag-ollama');
    expect(isOllamaLenient('ag-ollama')).toBe(true);
  });
});
