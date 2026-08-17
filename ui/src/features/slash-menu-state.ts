// ── Slash menu state ────────────────────────────────────────────────────────
// Bridge refs for the SlashMenu island. composer.ts still owns slashMatches and
// slashActive — the keyboard handlers move the selection — so these mirror them.
import { ref } from 'vue';

/** Commands matching what has been typed so far. */
export const slashRows = ref<any[]>([]);
/** Index of the highlighted row, moved by the composer's arrow keys. */
export const slashActiveIndex = ref(0);
