/**
 * An Ollama model tag as the server spells it (ollama-manage.ts
 * normalizeOllamaModelName): trimmed, lowercase, no whitespace. The UI must
 * compare in the same spelling, or a pull of "Llama3.2" reports as "llama3.2"
 * and the wait for it never ends.
 */
export function normalizeOllamaModelName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

/** The same model, allowing Ollama's implicit `:latest`. */
export function sameOllamaModel(a: string, b: string): boolean {
  const x = normalizeOllamaModelName(a);
  const y = normalizeOllamaModelName(b);
  return x === y || x === `${y}:latest` || `${x}:latest` === y;
}
