// ── Model picker state ──────────────────────────────────────────────────────
// Bridge refs for the ModelPicker island. legacy.js still owns allModels and
// the selection write-back; these are what the picker renders.
import { ref } from 'vue';

/** Rows in display order — the Default row is always first. */
export const pickerRows = ref<any[]>([]);
/** The model id currently assigned, '' for Default. */
export const pickerSelected = ref('');
/** Empty-state copy, or '' when rows should show. */
export const pickerEmptyNote = ref('');
