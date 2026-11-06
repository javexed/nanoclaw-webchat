/**
 * Tell an agent's running sessions that its SSH keys changed. The memory note
 * is read when a session starts, so a running session would not see a new key.
 * This drops a context-only message (trigger false: nothing wakes) into each
 * live session.
 */
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

export async function notifyKeyChange(agentGroupId: string, text: string): Promise<number> {
  let n = 0;
  const now = new Date();
  for (const s of await getSessionsByAgentGroup(agentGroupId)) {
    if (s.status !== 'active' || s.container_status === 'stopped') continue;
    try {
      await writeSessionMessage(agentGroupId, s.id, {
        id: `deploy-key-${now.getTime()}-${n}`,
        kind: 'chat',
        timestamp: now.toISOString(),
        platformId: agentGroupId,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
        trigger: false,
      });
      n++;
    } catch (err) {
      log.warn('Deploy key: session notice failed', { sessionId: s.id, err: String(err) });
    }
  }
  return n;
}
