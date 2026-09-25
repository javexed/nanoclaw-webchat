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
 * When on, every agent group is put into `selective` mode at spawn, with its
 * model credential pinned first so it does not lose the ability to talk to its
 * own provider. Off → OneCLI's default (`all`), so existing installs are
 * unaffected.
 *
 * Set it in Settings → Features → Credential isolation, which is read PER SPAWN
 * (see fleetIsolationEnabled below) so a change applies as agents next start,
 * with no host restart. `CREDENTIAL_ISOLATION=fleet` in .env remains the
 * fallback for an install that has never used the toggle.
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
import { registerSessionPrepareHook } from '../../seam/index.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { isolateAllGroups, isolateGroup, getGroupIsolation } from '../tool-secrets/index.js';
import { realOnecliAdmin, type OnecliAdmin } from '../user-credentials/onecli-admin.js';
import { readEnvFile } from '../../env.js';
import { getCredentialIsolation, setCredentialIsolation } from '../../channels/webchat/db.js';
import { log } from '../../log.js';

const fromEnvFile = readEnvFile(['CREDENTIAL_ISOLATION']);

/** `fleet` = isolate every agent group at spawn. Empty = OneCLI's default. */
export const CREDENTIAL_ISOLATION = (
  process.env.CREDENTIAL_ISOLATION ||
  fromEnvFile.CREDENTIAL_ISOLATION ||
  ''
).toLowerCase();

/**
 * Effective policy, read PER SPAWN rather than at module load.
 *
 * The Settings toggle wins when an operator has made a choice; NULL means they
 * have not, so the .env value still decides — an install that set
 * CREDENTIAL_ISOLATION=fleet keeps it without touching the UI. Reading it here
 * rather than at import is what makes the toggle take effect on the next spawn
 * instead of requiring a host restart.
 */
export async function fleetIsolationEnabled(): Promise<boolean> {
  try {
    const chosen = await getCredentialIsolation();
    if (chosen !== null) return chosen;
  } catch {
    // Settings table unavailable (early boot / fresh DB) — fall back to env.
  }
  return CREDENTIAL_ISOLATION === 'fleet';
}

/**
 * Make every agent private now, and every agent created later. Called before
 * a secret for one agent or one person is saved: any agent still in `all`
 * mode would be offered that secret too.
 *
 * Turns isolation on unless an owner turned it off in Admin; that choice is
 * refused rather than overridden. Throws, naming the agents, when one that
 * exists can't be isolated, so the secret is never stored while it would leak.
 */
export async function ensureFleetIsolation(admin: OnecliAdmin = realOnecliAdmin): Promise<void> {
  const chosen = await getCredentialIsolation();
  if (chosen === false)
    throw new Error('Credential isolation is off in Admin — turn it on to keep a secret to one agent or one person');
  if (chosen !== true && CREDENTIAL_ISOLATION !== 'fleet') {
    await setCredentialIsolation(true);
    log.info('Credential isolation turned on: a secret was saved for one agent or one person');
  }
  const { skipped } = await isolateAllGroups(admin);
  // A group with no OneCLI agent yet holds nothing and is isolated at its first spawn.
  const blocking = skipped.filter((s) => s.reason !== 'no OneCLI agent yet');
  if (blocking.length) {
    const names = await Promise.all(
      blocking.map(async (s) => `${(await getAgentGroup(s.id))?.name ?? s.id} (${s.reason})`),
    );
    throw new Error(`Couldn't make every agent private, so the secret was not saved: ${names.join('; ')}`);
  }
}

registerSessionPrepareHook(async (agentGroupId): Promise<void> => {
  // Gated first so an install with this off pays nothing per spawn.
  if (!(await fleetIsolationEnabled())) return;
  try {
    let { isolated, available } = await getGroupIsolation(realOnecliAdmin, agentGroupId);
    if (isolated) return; // already selective — nothing to do, and no vault writes
    if (!available) {
      const group = await getAgentGroup(agentGroupId);
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
