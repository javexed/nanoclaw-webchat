/**
 * The chat notice for a failed run, when the failure says something the user
 * can act on. A model removed from its server (an Ollama tag deleted, a cloud
 * model dropped from the router) failed every turn with "The agent run
 * failed. Check the logs for details." — the reason sat only in the runner
 * log. Lives here, not in the poll loop, so it is testable in a stock tree.
 */

/** The notice when nothing more specific is known. */
export const GENERIC_FAILURE = 'The agent run failed. Check the logs for details.';

/**
 * How each endpoint says the model is not there: Ollama (native, OpenAI and
 * Anthropic APIs alike) "model 'x' not found"; the LiteLLM router "Invalid
 * model name passed in model=x".
 */
const MODEL_GONE = [
  /model ['"\\]*([^'"\\\s]+)['"\\]* not found/i,
  /invalid model name passed in model=([^\s'"\\,]+)/i,
];

/** A specific notice for this failure, or null when the generic one applies. */
export function failureNotice(detail: string | undefined | null): string | null {
  if (!detail) return null;
  for (const re of MODEL_GONE) {
    const m = re.exec(detail);
    // Ids hold dots (qwen3:8b, llama3.1); only the sentence's own trailing punctuation goes.
    if (m) return `The model “${m[1].replace(/[.,;]+$/, '')}” is no longer available. Pick another model for this agent, or reinstall it.`;
  }
  return null;
}
