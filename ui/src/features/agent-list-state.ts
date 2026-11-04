// ── Agent-list view state ────────────────────────────────────────────────────
// Agent-list values that are NOT in the reactive `state` object.
import { ref } from 'vue';

/** Live filter from the Manage toolbar's filter box: agents on Agents, models on Models. */
export const agentFilter = ref('');

/** Restored from the session, so the A–Z preference survives a reload. */
export const agentSortAz = ref(sessionStorage.getItem('webchat:agentSortAz') === '1');
export const selectedAgentId = ref<string | null>(null);
