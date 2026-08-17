// ── MCP list view state ──────────────────────────────────────────────────────
// Bridge refs for the McpList island. Unlike the agent list — whose data is
// state.allAgents and already reactive — the MCP server list lives in legacy.js
// module state, so BOTH the rows and the selection are mirrored here and synced
// by renderMcpServers() on every call.
//
// Same bridge shape as agent-list-state.ts, and the same intent: when
// allMcpServers and selectedMcpId leave legacy.js this file becomes their
// declaration and the sync disappears.
import { ref } from 'vue';

export const mcpServers = ref<any[]>([]);
export const selectedMcpId = ref<string | null>(null);

/** MCP servers attached to the currently open agent. */
export const agentMcpServers = ref<any[]>([]);
/** Every registered MCP server. */
export const allMcpServers = ref<any[]>([]);
/** Last successful probe result, and the bearer token that made it work —
 *  carried into the add body so the registered server keeps working. */
export const lastMcpProbe = ref<any>(null);
export const lastMcpProbeToken = ref('');
/** Re-entry guard while an add is in flight. */
export const mcpAddInProgress = ref(false);
/** Agent the add flow should attach to on success, or null for unattached. */
export const mcpAgentForAdd = ref<string | null>(null);
