// ── Shared MCP registry surface ──────────────────────────────────────────────
// The MCP symbols that BOTH the MCP panel's own routes and the agent-side
// handlers touch: the built-in registry's id, the removed-entry key derived
// from it, the container reload that follows any change, and the UI shape an
// MCP server is projected into.
//
// Shared rather than moved. server/routes-mcp.ts owns the panel's handlers, but
// the agent wiring in server.ts assigns servers to agents and renders the same
// UI shape — so a third module both import is what keeps the graph acyclic.
// Same reason server/providers.ts exists.

import { restartAgentGroupContainers } from '../../../container-restart.js';
import { log } from '../../../log.js';
import { parseMcpAuth } from '../mcp-auth.js';
import { getAgentsAssignedToMcpServer } from '../mcp-registry.js';
import type { WebchatMcpServer, WebchatMcpTransport } from '../mcp-registry.js';

/** Restart a group's containers so an mcp_servers change is picked up at spawn. */
export function reloadAgentMcpServers(agentGroupId: string): void {
  try {
    const restarted = restartAgentGroupContainers(agentGroupId, 'Webchat MCP servers changed');
    if (restarted > 0) log.info('Webchat: restarted containers after MCP change', { agentGroupId, restarted });
  } catch (err) {
    log.warn('Webchat: container restart after MCP change failed', { agentGroupId, err });
  }
}

export interface McpServerForUI {
  id: string;
  name: string;
  transport: WebchatMcpTransport;
  /** Endpoint summary — url (remote) or command (stdio). Never env/headers. */
  target: string;
  agents_assigned: number;
  health: Record<string, unknown> | null;
  drift: Record<string, unknown> | null;
  pinned_tools: { name: string; description: string }[] | null;
  enabled_tools: string[] | null;
  /** Presence + kind only — the credential never leaves the host. */
  auth: { kind: string } | null;
}

export async function mcpServerForUI(s: WebchatMcpServer): Promise<McpServerForUI> {
  const parse = (v: string | null) => {
    try {
      return v ? (JSON.parse(v) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const pinned = parse(s.pinned_tools) as { tools?: { name: string; description: string }[] } | null;
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    target: (s.transport === 'stdio' ? s.command : s.url) ?? '',
    agents_assigned: (await getAgentsAssignedToMcpServer(s.id)).length,
    health: parse(s.health),
    drift: parse(s.drift),
    pinned_tools: pinned?.tools ?? null,
    enabled_tools: (parse(s.enabled_tools) as unknown as string[] | null) ?? null,
    // Presence only — the credential itself never leaves the host.
    auth: (() => {
      const a = parseMcpAuth(s);
      return a ? { kind: a.kind } : null;
    })(),
  };
}

/**
 * The registry is a code-wired built-in source, exactly like the skills
 * marketplace — so it switches off the same way, through webchat_disabled_sources.
 * Same id space, same helpers, no new table.
 */
export const MCP_REGISTRY_ID = 'mcp-registry';

// "Fully removed" is a stronger, separately-persisted state than disabled —
// same webchat_disabled_sources table, namespaced id, no schema change.
export const mcpRegistryRemovedKey = () => `removed:${MCP_REGISTRY_ID}`;
