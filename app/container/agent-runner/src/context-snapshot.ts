/**
 * Record what this runner put into the model's context, for the host's
 * `ncl groups context` view.
 *
 * The host composes the project document itself and can inspect it directly;
 * the system-prompt addendum and the memory section are built HERE, from
 * session state the host never assembles (live destinations, prompt-section
 * contributors, the group's memory files). Rather than have the host rebuild
 * them — a second copy that would drift — the runner stores the text it
 * actually built, once per spawn, in its own session state.
 *
 * Best effort: a failed write costs the inspector a row, never the agent a turn.
 */
import { getAgentMailbox } from './mailbox/index.js';
import { MEMORY_FILE_BUDGET_CHARS, MEMORY_TRUNCATION_NOTICE, renderMemorySection } from './memory/context.js';
import { getAllDestinations } from './destinations.js';
import { resolvePromptSections } from './seam/prompt-sections.js';

export const CONTEXT_SNAPSHOT_KEY = 'context:snapshot';

export interface ContextSnapshot {
  recordedAt: string;
  provider: string;
  /** The system-prompt addendum, exactly as handed to the provider. */
  addendum: string;
  /** Each prompt-section contributor's output, as it appears inside the addendum. */
  contributorSections: string[];
  /** The memory section the session-start hook renders, as of this spawn. */
  memory: string;
  /** True when a memory file ran past its budget and was cut. */
  memoryTruncated: boolean;
  memoryBudgetChars: number;
}

export function recordContextSnapshot(
  provider: string,
  addendum: string,
  capabilities: { mcpTools: boolean },
  memoryBaseDir?: string,
): void {
  try {
    let contributorSections: string[] = [];
    try {
      // Same call, same inputs as the addendum's own; contributors are pure
      // functions of the destinations and the capability flags.
      contributorSections = resolvePromptSections(getAllDestinations(), capabilities);
    } catch {
      // No destinations table yet: the addendum had no contributor sections either.
    }
    const memory = renderMemorySection(memoryBaseDir);
    const snapshot: ContextSnapshot = {
      recordedAt: new Date().toISOString(),
      provider,
      addendum,
      contributorSections: contributorSections.filter((s) => addendum.includes(s)),
      memory,
      memoryTruncated: memory.includes(MEMORY_TRUNCATION_NOTICE),
      memoryBudgetChars: MEMORY_FILE_BUDGET_CHARS,
    };
    getAgentMailbox().operations.setState(CONTEXT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Inspection aid only.
  }
}
