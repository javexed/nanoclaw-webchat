// Bridge ref for the AgentMcpList island — the servers attached to the agent
// currently open. renderAgentMcp() fetches, then syncs.
import { ref } from 'vue';
export const agentMcpRows = ref<any[]>([]);
