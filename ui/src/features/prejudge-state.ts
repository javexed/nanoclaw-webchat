// ── Approval pre-judge state ────────────────────────────────────────────────
// Bridge ref for the PrejudgeActions island; settings.ts owns the config fetch
// and the save.
import { ref } from 'vue';

/** One row per action: opted-in state and whether it is never-auto-approvable. */
export const prejudgeRows = ref<Array<{ action: string; checked: boolean; never: boolean }>>([]);

/** Judge-model options, filtered to what the PUT accepts. "Off" is a fixed
 *  first option, not in here. */
export const prejudgeModelOptions = ref<Array<{ id: string; label: string }>>([]);
