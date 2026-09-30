// ── MCP list view state ──────────────────────────────────────────────────────
// Refs for the McpList island; renderMcpServers() in mcp.ts syncs the rows and selection.
import { ref } from 'vue';

export const mcpServers = ref<any[]>([]);
export const selectedMcpId = ref<string | null>(null);

/** MCP servers attached to the currently open agent. */
export const agentMcpServers = ref<any[]>([]);
/** Every registered MCP server. */
export const allMcpServers = ref<any[]>([]);
/** Last successful probe result (the server response). */
export const lastMcpProbe = ref<any>(null);

// Bearer token of the last successful probe, carried into the add body. Kept out
// of lastMcpProbe so logging that object cannot leak it.
export const lastMcpProbeToken = ref('');
/** Re-entry guard while an add is in flight. */
export const mcpAddInProgress = ref(false);
/** Agent the add flow should attach to on success, or null for unattached. */
export const mcpAgentForAdd = ref<string | null>(null);
