/**
 * Whether an agent group runs on a local Ollama model, cached for the spawn path.
 *
 * Lenient output + prompt for ollama-backed groups. A small local model (a) rarely
 * emits the <message to="..."> envelope the runner requires — so lenientOutput
 * delivers its unwrapped prose to the origin room instead of dropping it as
 * scratchpad — and (b) drowns in the Claude provider's heavy `claude_code` system
 * prompt, hallucinating tool calls and identities — so lenientPrompt swaps that
 * preset for the plain persona/destinations instructions. Claude/anthropic groups
 * are unaffected (strict protocol + full preset preserved).
 *
 * The config augmentor that applies it is SYNC and runs while container.json is
 * written — before a spawn's prepare hooks — so the answer must already be here
 * when a spawn starts: it is primed at boot and refreshed whenever an agent's
 * model is (re)written, not only by a prepare hook that would be one spawn late.
 */
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { getEffectiveModelForAgent } from './db.js';

const lenient = new Map<string, boolean>();

// Ollama-backed = the webchat effective model is ollama-kind, or — with no webchat
// model at all — the install's .env ANTHROPIC_BASE_URL points at Ollama (:11434).
// The port match keeps a cloud proxy or the LiteLLM router (:4000) from being
// mistaken for a weak local model; a per-agent cloud assignment still wins.
async function isOllamaBackedAgent(agentGroupId: string): Promise<boolean> {
  const model = await getEffectiveModelForAgent(agentGroupId);
  if (model) return model.kind === 'ollama';
  return /:11434(\b|\/)/.test(readEnvFile(['ANTHROPIC_BASE_URL']).ANTHROPIC_BASE_URL ?? '');
}

/** Re-read one group. A read failure keeps the previous answer: it must not flip harness mode. */
export async function refreshOllamaLenient(agentGroupId: string): Promise<void> {
  try {
    lenient.set(agentGroupId, await isOllamaBackedAgent(agentGroupId));
  } catch (err) {
    log.warn('Ollama lenient-mode refresh failed; keeping the previous answer', { agentGroupId, err });
  }
}

/** Fill the cache for every group, so the first spawn after a restart is right. */
export async function primeOllamaLenient(): Promise<void> {
  for (const g of await getAllAgentGroups()) await refreshOllamaLenient(g.id);
}

export function isOllamaLenient(agentGroupId: string): boolean {
  return lenient.get(agentGroupId) ?? false;
}

export function __resetOllamaLenientForTest(): void {
  lenient.clear();
}
