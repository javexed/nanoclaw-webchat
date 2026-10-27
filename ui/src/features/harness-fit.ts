// ── Which harness runs which model ──────────────────────────────────────────
// The agent panel's mirror of the server's rule (models.ts harnessFits): a
// vendor harness runs its vendor's models. Claude: Anthropic models and the
// routing model. OpenCode: local and cloud models. pi: local models. Codex and
// Grok, Copilot: their own model (the model field), never a registry one. The model
// leads: picking one moves the agent to a harness that runs it (server side),
// and the Harness control offers only those.

/** Harnesses that bring their own model and sign-in. */
export const OWN_MODEL_HARNESSES: ReadonlySet<string> = new Set(['codex', 'grok', 'copilot']);

export interface FitModel {
  kind: string;
  model_id: string;
}

/** Which local harnesses are installed; null (not known yet) is read as both, the stricter answer for Claude. */
export interface LocalHarnesses {
  opencode: boolean;
  pi: boolean;
}

/**
 * Whether `provider` can run `model` (null: none assigned). `cloud`: the model
 * ids the router serves. Mirrors the server's harnessFits (models.ts): Claude
 * runs Anthropic models and anything no installed local harness takes — an
 * Ollama model when neither OpenCode nor pi is installed, a cloud model when
 * OpenCode is not.
 */
export function harnessRuns(
  provider: string,
  model: FitModel | null,
  cloud: ReadonlySet<string>,
  local: LocalHarnesses | null = null,
): boolean {
  if (!model || OWN_MODEL_HARNESSES.has(provider)) return true;
  const installed = local ?? { opencode: true, pi: true };
  const isCloud = model.kind === 'openai-compatible' && cloud.has(model.model_id);
  if (provider === 'claude') {
    if (model.kind === 'ollama') return !installed.opencode && !installed.pi;
    if (isCloud) return !installed.opencode;
    return true;
  }
  if (provider === 'opencode') return model.kind === 'ollama' || isCloud;
  if (provider === 'pi') return model.kind === 'ollama';
  return true;
}

/** Which model fields a harness uses: the registry picker, and the model field (its label, its suggestions). */
export function harnessFields(provider: string | null | undefined): {
  picker: boolean;
  pin: boolean;
  pinLabel: string;
  pinSuggestions: string[] | null;
} {
  const p = provider || 'claude';
  if (p === 'grok')
    return { picker: false, pin: true, pinLabel: 'Grok model', pinSuggestions: ['grok-4.6', 'grok-4.5'] };
  // Copilot's models depend on the seat; `auto` lets Copilot choose one it allows.
  if (p === 'copilot') return { picker: false, pin: true, pinLabel: 'Copilot model', pinSuggestions: ['auto'] };
  if (p === 'codex') return { picker: false, pin: true, pinLabel: 'Codex model', pinSuggestions: [] };
  if (p === 'claude') return { picker: true, pin: true, pinLabel: 'Anthropic model', pinSuggestions: null };
  return { picker: true, pin: false, pinLabel: '', pinSuggestions: [] };
}
