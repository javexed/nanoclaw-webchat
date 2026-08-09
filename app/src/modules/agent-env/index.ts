/**
 * Wire per-agent env vars into spawn, and tell the agent their NAMES.
 *
 * Names in context, values in the environment. An agent that doesn't know
 * `$SABNZBD_API_KEY` exists can't use it; an agent that can read its value has
 * gained nothing over a workspace file. So the note lists names only.
 */
import { registerContainerEnvResolver } from '../../container-runtime.js';
import { log } from '../../log.js';
import { listAgentEnvNames, readAgentEnv } from './store.js';

registerContainerEnvResolver((agentGroupId): Record<string, string> => {
  const vars = readAgentEnv(agentGroupId);
  const names = Object.keys(vars);
  // Log names, never values — this line goes to a file the operator greps.
  if (names.length) log.info('Agent env injected', { agentGroupId, names });
  return vars;
});

export { listAgentEnvNames };
