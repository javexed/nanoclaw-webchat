// ── My credentials state ────────────────────────────────────────────────────
// Refs for the MyCredentials island; settings.ts fetches the groups.
import { ref } from 'vue';

/** One group per agent the user uses: their personal credentials for it. */
export const myCredGroups = ref<any[]>([]);
/** Agent group ids whose add-form request is in flight. */
export const myCredSaving = ref<Set<string>>(new Set());
