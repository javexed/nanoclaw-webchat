// ── Wizard state ────────────────────────────────────────────────────────────
// Bridge refs for the onboarding wizard's islands. wizard.ts owns the
// probe result and every hidden/status flag around them; these mirror only what
// a component renders.
import { ref } from 'vue';

/** Model names returned by the last successful Ollama probe. */
export const wizardOllamaModels = ref<string[]>([]);
/** The model whose radio is checked. State, because two paths select one: the
 *  list's change listener and the post-pull path. */
export const wizardOllamaSelected = ref('');
