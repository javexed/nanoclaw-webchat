/**
 * The model that answered a reply, as the runner stamped it (container
 * served-model.ts): behind LiteLLM's 'auto' routing it differs from the
 * agent's configured model. Stored on the reply so a viewer who opted in can
 * see it; absent when the provider reported none.
 */
export const SERVED_MODEL_FIELD = 'servedModel';
const MAX_LEN = 128;

/** The served model a delivery carries, or null. Control characters are refused, not shown. */
export function servedModelOf(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const v = (content as Record<string, unknown>)[SERVED_MODEL_FIELD];
  if (typeof v !== 'string') return null;
  const m = v.trim();
  // eslint-disable-next-line no-control-regex
  if (!m || m.length > MAX_LEN || /[\u0000-\u001f\u007f]/.test(m)) return null;
  return m;
}
