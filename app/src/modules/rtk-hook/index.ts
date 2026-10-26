/**
 * The rtk PreToolUse hook on every Claude group.
 *
 * rtk compresses Bash tool output before it reaches the model; the binary is
 * baked into the agent image and the hook is declared in the group's
 * settings.json. group-init declared it through `ensureHook`, but only on the
 * legacy settings path: a Claude group prepares its settings through the
 * provider contract, which never reaches that branch, so every group created
 * since then ran without rtk.
 *
 * Declared here by extending the Claude settings reconcile instead — the
 * `claude-settings` transformer both paths call on every group init (so at
 * every spawn). Added where missing, never removed, other hooks untouched.
 */
import { RTK_HOOK } from '../../group-init.js';
import { claudeSettingsTransformer } from '../../migrate-claude-memory-settings.js';
import type { ProviderFileTransformer } from '../../provider-contracts/file-transformers.js';

const RTK_COMMAND = RTK_HOOK.hooks[0].command;

/** `content` with the rtk hook added, or null when already there or not a JSON object. */
export function withRtkHook(content: string): string | null {
  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(settings)) return null;
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  if (JSON.stringify(preToolUse).includes(RTK_COMMAND)) return null;
  preToolUse.push(RTK_HOOK);
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;
  return JSON.stringify(settings, null, 2) + '\n';
}

const reconcileClaudeSettings = claudeSettingsTransformer.transform.bind(claudeSettingsTransformer);
Object.assign(claudeSettingsTransformer, {
  transform(current, filePath) {
    const result = reconcileClaudeSettings(current, filePath);
    const next = withRtkHook(result.kind === 'replace' ? result.content : current);
    if (next === null) return result;
    return { kind: 'replace', content: next, diagnostics: result.diagnostics };
  },
} satisfies Pick<ProviderFileTransformer, 'transform'>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
