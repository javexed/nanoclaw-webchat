// ── Mention popover state ───────────────────────────────────────────────────
// Bridge refs for the MentionPopover island. The match list and the selected
// index are still legacy module state, driven by the composer's keystrokes.
import { ref } from 'vue';

/** Candidate agents/people for the @-token being typed. */
export const mentionMatches = ref<any[]>([]);
/** Which candidate is highlighted — driven by arrow keys in the composer. */
export const mentionSelectedIndex = ref(0);
