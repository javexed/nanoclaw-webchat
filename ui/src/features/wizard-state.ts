// ── Wizard state ────────────────────────────────────────────────────────────
// Bridge refs for the onboarding wizard's islands. wizard.ts still owns the
// probe result and every hidden/status flag around them; these mirror only what
// a component renders.
import { ref } from 'vue';

/** Model names returned by the last successful Ollama probe. */
export const wizardOllamaModels = ref<string[]>([]);
/**
 * The model whose radio is checked.
 *
 * State rather than a DOM write because two paths select one: the delegated
 * change listener on the list, and the post-pull path, which used to find the
 * radio with querySelector and set .checked on it directly.
 */
export const wizardOllamaSelected = ref('');
