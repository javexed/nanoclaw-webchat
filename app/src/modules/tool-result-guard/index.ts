/**
 * Tool-result guard wiring: every Claude group's settings.json gets a
 * `PostToolUse` command hook that screens tool output before the model reads
 * it. The guard itself runs in the container
 * (container/agent-runner/src/tool-result-guard.ts, mounted at /app/src); this
 * module only makes sure the hook is declared.
 *
 * Declared by extending the Claude settings reconcile rather than group-init:
 * the Claude provider's settings file is prepared through its provider
 * contract, which runs the `claude-settings` transformer on every group init
 * (so at every spawn). Wrapping that transformer — the same object the legacy
 * path calls — puts the hook on every existing group at its next spawn, and on
 * a new group from its first spawn after creation. It is added where missing
 * and never removed, so an operator's own hooks are left alone.
 *
 * The Claude provider also declares the same hook in its flag-level settings,
 * which the agent cannot edit; Claude Code runs the two copies once.
 *
 * Off switch: `NANOCLAW_TOOL_RESULT_GUARD=off` in the group's environment.
 * The hook stays declared and exits silently; see the guard's header.
 */
import { claudeSettingsTransformer } from '../../migrate-claude-memory-settings.js';
import type { ProviderFileTransformer } from '../../provider-contracts/file-transformers.js';

export const TOOL_RESULT_GUARD_COMMAND = 'bun /app/src/tool-result-guard.ts';

/**
 * Every tool (`*`). `timeout` is Claude Code's ceiling in seconds; the guard
 * keeps its own far shorter budget and reports `unscreened` when it runs out.
 */
const TOOL_RESULT_GUARD_HOOK = {
  matcher: '*',
  hooks: [{ type: 'command', command: TOOL_RESULT_GUARD_COMMAND, timeout: 10 }],
};

/**
 * `content` with the guard hook added, or null when it is already there or the
 * file is not a JSON object (left for the reconcile's own diagnostics).
 */
export function withToolResultGuardHook(content: string): string | null {
  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(settings)) return null;
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const postToolUse = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  if (postToolUse.some(isGuardEntry)) return null;
  postToolUse.push(TOOL_RESULT_GUARD_HOOK);
  hooks.PostToolUse = postToolUse;
  settings.hooks = hooks;
  return JSON.stringify(settings, null, 2) + '\n';
}

const reconcileClaudeSettings = claudeSettingsTransformer.transform.bind(claudeSettingsTransformer);
Object.assign(claudeSettingsTransformer, {
  transform(current, filePath) {
    const result = reconcileClaudeSettings(current, filePath);
    const next = withToolResultGuardHook(result.kind === 'replace' ? result.content : current);
    if (next === null) return result;
    return { kind: 'replace', content: next, diagnostics: result.diagnostics };
  },
} satisfies Pick<ProviderFileTransformer, 'transform'>);

/**
 * An entry that really runs the guard on every tool: matcher `*` (or none) and
 * a command hook with exactly the guard command. The settings file is
 * agent-writable, so a near-miss — the command under a matcher that matches
 * nothing, or inside some other string — must not count as declared.
 */
function isGuardEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (entry.matcher !== undefined && entry.matcher !== '*' && entry.matcher !== '') return false;
  return (
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => isRecord(h) && h.type === 'command' && h.command === TOOL_RESULT_GUARD_COMMAND)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
