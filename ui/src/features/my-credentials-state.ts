// ── My credentials state ────────────────────────────────────────────────────
// Refs for the MyCredentials island; settings.ts fetches the groups.
import { ref } from 'vue';

/** One group per agent the user has personal credentials for. */
export const myCredGroups = ref<any[]>([]);
/** Agent group ids whose add-form request is in flight. */
export const myCredSaving = ref<Set<string>>(new Set());
