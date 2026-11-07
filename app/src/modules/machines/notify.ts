/**
 * Tell an agent's running sessions about its machines.
 *
 * Memory (the credential note) is read when a session starts, so a session
 * already running when a machine comes up never sees it. This drops a
 * context-only message into each live session: trigger false, so nothing
 * wakes, and the agent reads it with its next message.
 */
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

export async function notifyAgent(agentGroupId: string, text: string): Promise<number> {
  let n = 0;
  const now = new Date();
  for (const s of await getSessionsByAgentGroup(agentGroupId)) {
    if (s.status !== 'active' || s.container_status === 'stopped') continue;
    try {
      await writeSessionMessage(agentGroupId, s.id, {
        id: `machine-${now.getTime()}-${n}`,
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
      log.warn('Machine: session notice failed', { sessionId: s.id, err: String(err) });
    }
  }
  return n;
}

/** The notice for a machine that is up: its key and where it points. */
export const machineReadyText = (key: string, target: string): string =>
  `[System] Your SSH key "${key}" (/workspace/agent/deploy_key_${key}, not under ~/.ssh) now points at ${target}. ` +
  'Never print or share the private key.';

export const machineKeyRemovedText = (key: string): string =>
  `[System] The SSH key "${key}" was removed with its machine.`;
