// Bridge refs for the AgentSkillsList island: the available skills and which
// are enabled. renderAgentSkills() fetches, then syncs.
import { ref } from 'vue';
export const agentSkillRows = ref<any[]>([]);
export const agentSkillsEnabled = ref<Set<string>>(new Set());
/** The list's search box, as typed. */
export const agentSkillsQuery = ref('');
