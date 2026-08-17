// ── Learn menu state ────────────────────────────────────────────────────────
// Bridge refs for the LearnMenu island. learn.ts still fetches the room's
// learning config and owns the actions; this holds what the menu renders.
import { ref } from 'vue';

/**
 * Whether the two room-scoped toggles are shown at all. They appear only when
 * the caller can manage this room's learning AND the workspace master is on.
 */
export const learnTogglesVisible = ref(false);
/** Auto-distill busy turns, for this room. */
export const learnAutoTrigger = ref(false);
/** Auto-keep drafts, for this room. */
export const learnAutoKeep = ref(false);
