/**
 * Auto-compact window for Claude agent containers.
 *
 * The agent-runner defaults to 165000 tokens, sized for 200K-context models.
 * Every model the fleet pins today has a far larger window, so that default can
 * force compaction at a fraction of capacity and thrash — one agent hit 95
 * compactions in a single session, roughly one every three minutes, with only
 * ~11-16k tokens of new work between them.
 *
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in .env raises it. Unset → the runner's own
 * default stands, so installs are unaffected.
 *
 * Delivered through the container-env seam rather than as a core patch: the
 * value is per-agent-group (it depends on the group's provider) and the seam
 * expresses that without touching nanoclaw-owned files. Patches only shrink.
 */
import { registerContainerEnvResolver } from '../../container-runtime.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { readEnvFile } from '../../env.js';

const fromEnvFile = readEnvFile(['CLAUDE_CODE_AUTO_COMPACT_WINDOW']);

/** Operator-set window, process env winning over .env. Empty when unset. */
export const CLAUDE_CODE_AUTO_COMPACT_WINDOW =
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || fromEnvFile.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '';

registerContainerEnvResolver((agentGroupId): Record<string, string> => {
  if (!CLAUDE_CODE_AUTO_COMPACT_WINDOW) return {};
  // Claude only. opencode / ollama / codex configure their own limits
  // elsewhere, and handing them this variable would be noise at best.
  const provider = getContainerConfig(agentGroupId)?.provider ?? 'claude';
  if (provider !== 'claude') return {};
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW };
});
