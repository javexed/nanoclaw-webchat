// ── Approval pre-judge state ────────────────────────────────────────────────
// Bridge ref for the PrejudgeActions island. legacy.js still owns the config
// fetch and the save; this is the action checklist.
import { ref } from 'vue';

/** One row per action: opted-in state and whether it is never-auto-approvable. */
export const prejudgeRows = ref<Array<{ action: string; checked: boolean; never: boolean }>>([]);

/**
 * Judge-model options, already filtered to what the PUT accepts and labelled.
 *
 * "Off" is not in here — it is a fixed first option, not a model.
 */
export const prejudgeModelOptions = ref<Array<{ id: string; label: string }>>([]);
