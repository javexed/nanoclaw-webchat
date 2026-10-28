// ── Agent → Apps: the island ────────────────────────────────────────────────
// Mounts AgentApps.vue into the agent detail's Apps accordion once, and loads
// the open agent's apps into it (apps-actions.ts).
import { createApp } from 'vue';
import { mountIsland } from '../core/island.js';
import AgentApps from './AgentApps.vue';
import { loadAgentApps } from './apps-actions.js';

let appsApp: ReturnType<typeof createApp> | null = null;

export async function renderAgentApps(agentId: string): Promise<void> {
  await loadAgentApps(agentId);
  appsApp ??= mountIsland('#agent-apps', () => createApp(AgentApps));
}
