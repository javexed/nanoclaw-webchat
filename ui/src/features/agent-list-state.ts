// ── Agent-list view state ────────────────────────────────────────────────────
// The two values the AgentList island needs that are NOT in the reactive
// `state` object: the A–Z toggle and the currently-open agent. Both still live
// in legacy.js — selectedAgentId is read in seven places there — so they are
// mirrored into refs that renderAgents() syncs on every call.
//
// Deliberately a bridge, not a home. When those two finally move out of
// legacy.js this file becomes their declaration and the sync disappears; until
// then the island stays reactive without requiring that move first.
import { ref } from 'vue';

/** Restored from the session — the sessionStorage read was the `let`'s
 *  initialiser in legacy.js, and dropping it turns a remembered preference
 *  into a per-reload default. */
/** Live agent-name filter, driven by the Manage toolbar's filter box. */
export const agentFilter = ref('');

export const agentSortAz = ref(sessionStorage.getItem('webchat:agentSortAz') === '1');
export const selectedAgentId = ref<string | null>(null);
