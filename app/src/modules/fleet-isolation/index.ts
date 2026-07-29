/**
 * Fleet credential isolation (opt-in).
 *
 * A freshly created OneCLI agent defaults to `all` secret mode, where the
 * gateway hands it EVERY vault secret whose host pattern matches — including
 * other agents' per-agent credentials. So on a fleet that was deliberately
 * locked down, the next new agent silently re-opens it. Credential scoping is
 * all-or-nothing per agent, so there is no partial answer: an agent is either
 * isolated or it sees everything matching.
 *
 * `CREDENTIAL_ISOLATION=fleet` in .env puts every agent group into `selective`
 * mode at spawn, with its model credential pinned first so it does not lose the
 * ability to talk to its own provider. Unset → OneCLI's default (`all`), so
 * existing installs are unaffected.
 *
 * DELIVERED AS A MODULE, NOT A CORE PATCH. The author wrote this as edits to
 * config.ts + container-runner.ts (isolating inline, right after
 * `onecli.ensureAgent`). The session-prepare seam expresses the same intent
 * without touching nanoclaw-owned files, and this repo's rule is that patches
 * only shrink — the same call made for the auto-compact window in
 * modules/compact-window.
 *
 * The one thing that placement costs us: prepare hooks run BEFORE
 * buildContainerArgs calls `onecli.ensureAgent`, so on a group's very first
 * spawn the agent does not exist yet and `isolateGroup` would throw "No OneCLI
 * agent for this group yet". We therefore ensure the agent here first.
 * `ensureAgent` is idempotent and container-runner calls it again moments
 * later, so the cost is one redundant vault call on the isolation path only —
 * and it mirrors what createToolSecret already does when an operator adds a
 * secret to a never-spawned group.
 */
import { registerSessionPrepareHook } from '../../container-runtime.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { isolateGroup, getGroupIsolation } from '../tool-secrets/index.js';
import { realOnecliAdmin } from '../user-credentials/onecli-admin.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const fromEnvFile = readEnvFile(['CREDENTIAL_ISOLATION']);

/** `fleet` = isolate every agent group at spawn. Empty = OneCLI's default. */
export const CREDENTIAL_ISOLATION = (
  process.env.CREDENTIAL_ISOLATION ||
  fromEnvFile.CREDENTIAL_ISOLATION ||
  ''
).toLowerCase();

registerSessionPrepareHook(async (agentGroupId): Promise<void> => {
  // Gated first so an install that never sets this pays nothing per spawn.
  if (CREDENTIAL_ISOLATION !== 'fleet') return;
  try {
    let { isolated, available } = await getGroupIsolation(realOnecliAdmin, agentGroupId);
    if (isolated) return; // already selective — nothing to do, and no vault writes
    if (!available) {
      const group = getAgentGroup(agentGroupId);
      if (!group) return;
      await realOnecliAdmin.ensureAgent(group.name, agentGroupId);
    }
    await isolateGroup(realOnecliAdmin, agentGroupId);
  } catch (err) {
    // Best-effort by design: a vault hiccup must never block a spawn. The
    // agent comes up in `all` mode and the next spawn retries — louder than
    // silence, but not at the cost of the user's turn.
    log.warn('Could not isolate agent credentials at spawn', { agentGroupId, err: String(err) });
  }
});
