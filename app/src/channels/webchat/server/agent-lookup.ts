// ── Agent lookup ─────────────────────────────────────────────────────────────
// Resolving an agent group by id and listing the ones a user may see. Read-only
// and used almost everywhere: the agent routes, the skill routes, and the
// permission-scoped listings.
//
// Extracted ahead of the agent routes because the skill routes need it and
// neither cluster owns it.

/**
 * Agent list shape returned to the PWA. Adds `room_id` (the wired webchat
 * room id, if any) so the PWA can map agents to rooms without baking in v1's
 * `chat:<folder>` jid convention.
 */
import { getAgentGroup, getAllAgentGroups } from '../../../db/agent-groups.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import type { AgentGroup } from '../../../types.js';
import { getAssignedModelForAgent, getEffectiveModelForAgent, getWebchatRoom } from '../db.js';
import { hasAdminPrivilege, isOwner } from '../roles.js';
import { filterAsync } from '../async-array.js';

export interface AgentForUI extends AgentGroup {
  room_id: string | null;
  assigned_model_id: string | null;
  /**
   * When no webchat model is assigned, a label derived from the agent's actual
   * runtime provider (container_configs.provider), so the PWA can show what the
   * agent really runs on instead of defaulting to "Built-in Anthropic". null
   * when a model IS assigned (the PWA shows that model) or the provider is the
   * built-in Claude path (the PWA shows its Anthropic default).
   */
  effective_model_label: string | null;
  /**
   * `container_configs.model` — the Anthropic model id pinned for this agent, or
   * null for the SDK default. This is what the agent-runner passes to the Claude
   * Agent SDK, so it is the authoritative model for the built-in harness; the
   * PWA edits it through PUT /api/agents/:id/config-model.
   */
  config_model: string | null;
  /** The agent harness: 'claude' (built-in) or 'opencode'. */
  provider: string;
  /**
   * Network egress: 'open' (the column's NULL/absent state) or 'host-only'
   * (internal network, credential gateway is the only hop out). Surfaced so the
   * agent panel can show the current mode without a second round trip.
   * 'none' is settable only via ncl and is reported verbatim if someone set it.
   */
  egress: string;
}

/**
 * Derive a display label for an agent with NO assigned webchat model, from its
 * runtime provider. Returns null for the built-in Claude path (caller shows the
 * Anthropic default). Only a non-Claude harness (Codex, Grok) gets an explicit label.
 */
export async function deriveEffectiveModelLabel(agentGroupId: string): Promise<string | null> {
  const cfg = await getContainerConfig(agentGroupId);
  const provider = cfg?.provider ?? 'claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'grok') return 'Grok';
  // Claude family with no assignment: the group may still run on the WORKSPACE
  // DEFAULT model (the wizard's Ollama engine). Label it honestly — showing
  // "anthropic" for an agent that answers via Ollama misleads the operator.
  const effective = getEffectiveModelForAgent(agentGroupId);
  if (effective) return `${effective.model_id} (workspace default)`;
  // A model pinned in container_configs (webchat's own field, or `ncl groups
  // config update --model`) is what the SDK is actually handed. Showing the
  // generic Anthropic default for it was the visible half of this bug: an agent
  // explicitly pinned to claude-opus-5 still read as "Built-in Anthropic".
  if (cfg?.model) return `${cfg.model} (pinned)`;
  return null;
}

export async function toAgentForUI(g: AgentGroup): Promise<AgentForUI> {
  // Convention: createAgentHandler uses `group.folder` as the webchat_room id when it
  // creates a room alongside the agent. Look that up directly so the PWA
  // doesn't have to guess.
  const room = await getWebchatRoom(g.folder);
  const assigned = await getAssignedModelForAgent(g.id);
  return {
    ...g,
    room_id: room ? room.id : null,
    assigned_model_id: assigned ? assigned.id : null,
    egress: (await getContainerConfig(g.id))?.egress ?? 'open',
    effective_model_label: assigned ? null : deriveEffectiveModelLabel(g.id),
    config_model: (await getContainerConfig(g.id))?.model ?? null,
    // Which agent harness the group runs: 'claude' (built-in) or 'opencode'.
    provider: ((await getContainerConfig(g.id))?.provider as string | null) || 'claude',
  };
}

export function resolveAgent(idOrJid: string): AgentGroup | null {
  return getAgentGroup(idOrJid) ?? null;
}

export async function listAgentsForUser(userId: string, includeArchived = false): Promise<AgentForUI[]> {
  const all = await getAllAgentGroups();
  const role = (await isOwner(userId)) ? all : await filterAsync(all, (g) => hasAdminPrivilege(userId, g.id));
  // Archived agents are hidden by default — this declutters every consumer
  // (agent list, pickers, topology/matrix) at once. The agent list opts in via
  // ?includeArchived=1 so they can still be managed (unarchived).
  const visible = includeArchived ? role : role.filter((g) => g.status !== 'archived');
  return visible.map(toAgentForUI);
}
