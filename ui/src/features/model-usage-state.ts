// ── Model assignee state ────────────────────────────────────────────────────
// Bridge ref for the ModelUsage island. models.ts still opens the detail pane;
// this is only the "assigned to" line.
import { ref } from 'vue';

/** Agent names this model is assigned to. Empty renders the not-assigned note. */
export const modelAssignees = ref<string[]>([]);
