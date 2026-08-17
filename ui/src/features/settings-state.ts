// ── Settings panel state ────────────────────────────────────────────────────
import { ref } from 'vue';

/**
 * Pending timer for the bearer-token retirement confirm, else null.
 *
 * A second click inside the window is the confirm; letting it lapse cancels —
 * so the handle IS the "are we confirming?" state, not a detail of it.
 */
export const bearerConfirmTimer = ref<ReturnType<typeof setTimeout> | null>(null);
/** Which speech backend the operator picked in the STT installer: 'local' | … */
export const sttChosenBackend = ref('local');
