/**
 * Fleet credential isolation (opt-in).
 *
 * A freshly created OneCLI agent defaults to `all` secret mode, where the
 * gateway hands it EVERY vault secret whose host pattern matches — including
 * other agents' per-agent credentials — so on a locked-down fleet the next new
 * agent silently re-opens it. When on, every agent group is put into
 * `selective` mode at spawn, model credential pinned first. Off → OneCLI's
 * default (`all`).
 *
 * The Settings toggle is read PER SPAWN (fleetIsolationEnabled);
 * `CREDENTIAL_ISOLATION=fleet` in .env is the fallback when it was never set.
 *
 * Runs as a session-prepare hook, which fires BEFORE container-runner's
 * `onecli.ensureAgent`, so the agent is ensured here first (idempotent) —
 * otherwise a group's first spawn would have no agent to isolate.
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
 * Effective policy, read PER SPAWN so a toggle applies without a restart. The
 * Settings choice wins; NULL (never chosen) defers to the .env value.
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
