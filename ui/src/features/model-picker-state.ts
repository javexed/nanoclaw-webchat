// ── Model picker state ──────────────────────────────────────────────────────
// Refs for the ModelPicker island; models.ts owns the selection write-back.
import { ref } from 'vue';

/** Rows in display order — the Default row is always first. */
export const pickerRows = ref<any[]>([]);
/** The model id currently assigned, '' for Default. */
export const pickerSelected = ref('');
/** Empty-state copy, or '' when rows should show. */
export const pickerEmptyNote = ref('');
