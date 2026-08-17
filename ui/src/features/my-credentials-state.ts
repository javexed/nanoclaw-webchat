// ── My credentials state ────────────────────────────────────────────────────
// Bridge ref for the MyCredentials island. legacy.js still fetches the groups
// and owns the section's hidden flag.
import { ref } from 'vue';

/** One group per agent the user has personal credentials for. */
export const myCredGroups = ref<any[]>([]);
/** Agent group ids whose add-form request is in flight. */
export const myCredSaving = ref<Set<string>>(new Set());
