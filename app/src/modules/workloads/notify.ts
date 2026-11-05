// Telling an agent about its workloads (expiry, disk) when nothing it ran asked.
import { TIMEZONE } from '../../config.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { resolveTimezone } from '../../timezone.js';
import { notifyAgent } from '../approvals/index.js';

/** A day as an agent passes it on, "1 Dec", in the install's timezone. */
export const dayText = (ms: number, tz = TIMEZONE): string =>
  new Date(ms).toLocaleDateString('en-GB', { timeZone: resolveTimezone(tz), day: 'numeric', month: 'short' });

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
