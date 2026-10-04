/**
 * The context window Ollama actually serves a model with, for the local
 * harnesses (pi, OpenCode) to declare.
 *
 * Over its OpenAI-compatible API a client cannot ask for a window: Ollama runs
 * the model with its Modelfile num_ctx, or else its own default (4096, or the
 * server's OLLAMA_CONTEXT_LENGTH — visible once the model is loaded). A
 * harness told more than that never compacts before Ollama silently cuts the
 * prompt.
 */
/** Ollama's window when nothing sets one. */
export const OLLAMA_DEFAULT_CONTEXT = 4096;
/** Output never gets more than this, nor more than a quarter of the window. */
export const MAX_OUTPUT_TOKENS = 8192;

export interface OllamaModelMeta {
  /** The window the Modelfile sets (parameters num_ctx). */
  numCtx: number | null;
  /** The window the loaded model runs with (/api/ps), when it is loaded. */
  loadedCtx?: number | null;
  /** The architecture's ceiling (model_info.<arch>.context_length). */
  maxContext: number | null;
  vision: boolean;
}

/** Parse an Ollama /api/show body. */
export function parseOllamaShow(body: unknown): OllamaModelMeta {
  const show = (body && typeof body === 'object' ? body : {}) as {
    parameters?: unknown;
    model_info?: Record<string, unknown>;
    capabilities?: unknown;
  };
  const numCtx = typeof show.parameters === 'string' ? /num_ctx\s+(\d+)/.exec(show.parameters)?.[1] : undefined;
  let maxContext: number | null = null;
  for (const [k, v] of Object.entries(show.model_info ?? {})) {
    if (k.endsWith('.context_length') && typeof v === 'number') maxContext = v;
  }
  return {
    numCtx: numCtx ? Number(numCtx) : null,
    maxContext,
    vision: Array.isArray(show.capabilities) && show.capabilities.includes('vision'),
  };
}

/** The loaded model's window from an Ollama /api/ps body, or null when it is not loaded. */
export function parseOllamaPs(body: unknown, model: string): number | null {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const names = model.includes(':') ? [model] : [model, `${model}:latest`];
  for (const m of models as Array<{ name?: unknown; model?: unknown; context_length?: unknown }>) {
    if (!names.includes(String(m.name)) && !names.includes(String(m.model))) continue;
    return typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : null;
  }
  return null;
}

/** num_ctx, else the loaded window, else Ollama's default — capped by the architecture's ceiling. */
export function servedContextWindow(meta: OllamaModelMeta): number {
  const window = meta.numCtx ?? meta.loadedCtx ?? OLLAMA_DEFAULT_CONTEXT;
  return meta.maxContext ? Math.min(window, meta.maxContext) : window;
}

export function servedModelLimits(meta: OllamaModelMeta): { contextWindow: number; maxTokens: number } {
  const contextWindow = servedContextWindow(meta);
  return { contextWindow, maxTokens: Math.min(MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4)) };
}

const META_TTL_MS = 10 * 60_000;
const META_TIMEOUT_MS = 2000;
const metaCache = new Map<string, { meta: OllamaModelMeta | null; at: number }>();

/** Test hook: forget cached model metadata. */
export function clearOllamaModelMetaCache(): void {
  metaCache.clear();
}

async function ollamaJson(url: URL, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(META_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Ask the model server what it runs the model with. `baseURL` may be the
 * container's view; the host reaches host.docker.internal on loopback. Null
 * when the server is not Ollama or does not answer quickly — a spawn never
 * waits long on a model server.
 */
export async function fetchOllamaModelMeta(baseURL: string, model: string): Promise<OllamaModelMeta | null> {
  const key = `${baseURL}\u0000${model}`;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
  let meta: OllamaModelMeta | null = null;
  try {
    const root = baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
    const at = (p: string): URL => {
      const u = new URL(root + p);
      if (u.hostname === 'host.docker.internal') u.hostname = '127.0.0.1';
      return u;
    };
    const [show, ps] = await Promise.all([
      ollamaJson(at('/api/show'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      }),
      ollamaJson(at('/api/ps')).catch(() => null),
    ]);
    meta = { ...parseOllamaShow(show), loadedCtx: parseOllamaPs(ps, model) };
  } catch {
    /* not reachable from the host, or not Ollama */
  }
  metaCache.set(key, { meta, at: Date.now() });
  return meta;
}
