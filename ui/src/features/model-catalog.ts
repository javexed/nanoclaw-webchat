// ── Local model catalog ─────────────────────────────────────────────────────
// What the Add model → Server step offers to pull, per family: Ollama tags,
// their default download size, and a licence badge where use is restricted.
// A short list on purpose; any other tag can be typed.

export interface CatalogModel {
  tag: string;
  /** Default download, GB (Ollama's default quantisation). */
  gb: number;
  /** A restriction worth a badge; absent for permissive licences. */
  licence?: 'Non-commercial' | 'Non-production';
}

export const MODEL_CATALOG: Record<string, CatalogModel[]> = {
  Mistral: [
    { tag: 'mistral:7b', gb: 4.1 },
    { tag: 'mistral-nemo:12b', gb: 7.1 },
    { tag: 'mistral-small:24b', gb: 14 },
    { tag: 'codestral:22b', gb: 13, licence: 'Non-production' },
  ],
  Cohere: [
    { tag: 'command-r7b:7b', gb: 5.1, licence: 'Non-commercial' },
    { tag: 'aya-expanse:8b', gb: 5.1, licence: 'Non-commercial' },
    { tag: 'command-r:35b', gb: 19, licence: 'Non-commercial' },
    { tag: 'command-a:111b', gb: 67, licence: 'Non-commercial' },
  ],
  Qwen: [
    { tag: 'qwen3:4b', gb: 2.5 },
    { tag: 'qwen3:8b', gb: 5.2 },
    { tag: 'qwen3:14b', gb: 9.3 },
  ],
  Llama: [{ tag: 'llama3.1:8b', gb: 4.9 }],
  Gemma: [
    { tag: 'gemma3:4b', gb: 3.3 },
    { tag: 'gemma3:12b', gb: 8.1 },
  ],
};
