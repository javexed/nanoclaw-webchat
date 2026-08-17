// ── Codex pairing code state ────────────────────────────────────────────────
// Bridge refs for the CodexPairingCode island. modals.ts still drives the OAuth
// mint flow; this is only what the pairing-code line shows.
import { ref } from 'vue';

/** The device code to enter at the sign-in page. Empty when there is none. */
export const codexUserCode = ref('');
/** true when the flow is Codex at all — otherwise the line renders nothing. */
export const codexActive = ref(false);
