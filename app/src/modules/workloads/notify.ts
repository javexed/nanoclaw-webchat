// Telling an agent about its workloads (expiry, disk) when nothing it ran asked.
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { notifyAgent } from '../approvals/index.js';

/** A system line into the agent's most recently active session; nothing when it has none. */
export async function notifyWorkloadAgent(agentGroupId: string, text: string): Promise<void> {
  const sessions = (await getSessionsByAgentGroup(agentGroupId)).filter((s) => s.status === 'active');
  const latest = sessions.sort((a, b) =>
    String(b.last_active ?? b.created_at).localeCompare(String(a.last_active ?? a.created_at)),
  )[0];
  if (!latest) return;
  await notifyAgent(latest, text).catch((err) =>
    log.warn('Workload notice not delivered', { agentGroupId, err: String(err).slice(0, 200) }),
  );
}
