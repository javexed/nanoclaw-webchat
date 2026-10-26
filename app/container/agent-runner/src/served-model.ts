/**
 * The model that actually answered, as the API response named it.
 *
 * Behind a routing proxy (LiteLLM's virtual 'auto' model) the configured model
 * is not the one that served the turn: each request is classified and sent on
 * to a concrete model, and the response says which. The provider notes each
 * response's model here; the poll loop stamps the latest onto the replies it
 * writes, so a channel can show it. Unknown (a provider that does not report
 * one, or nothing answered yet this query) means no field at all.
 */
export const SERVED_MODEL_FIELD = 'servedModel';

const MAX_LEN = 128;
let current: string | null = null;

export function noteServedModel(model: unknown): void {
  if (typeof model !== 'string') return;
  const m = model.trim();
  if (m) current = m.slice(0, MAX_LEN);
}

/** Forget it — a new query has not been answered by anything yet. */
export function resetServedModel(): void {
  current = null;
}

/** `{ servedModel }` when known, else `{}` — spread into a reply's content. */
export function servedModelField(): Record<string, string> {
  return current ? { [SERVED_MODEL_FIELD]: current } : {};
}

/**
 * The content with any served-model stamp removed, for comparing a reply's
 * content with what another write would have been: the stamp says which model
 * wrote it, not what was said.
 */
export function withoutServedModel(content: string): string {
  if (!content.includes(`"${SERVED_MODEL_FIELD}"`)) return content;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    delete parsed[SERVED_MODEL_FIELD];
    return JSON.stringify(parsed);
  } catch {
    return content;
  }
}
