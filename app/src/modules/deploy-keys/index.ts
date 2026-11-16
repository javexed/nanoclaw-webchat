/**
 * Deploy keys: the boot entry point. Registers what runs around a container
 * (view, agent, env), the egress filter's per-agent targets, the sweep, and
 * `ncl deploy-keys`. The operations live in keys.ts, which other modules
 * import without pulling these hooks in.
 */
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { registerModuleSweep } from '../../module-sweep.js';
import { registerContainerEnvResolver, registerSessionPrepareHook } from '../../seam/index.js';
import { registerKeyTargets } from '../../channels/webchat/egress-key-targets.js';
import './cli.js';
import { ensureAgent, stopAllAgents, sweepAgents } from './agent.js';
import { groupIsLive, pinTarget } from './keys.js';
import { hopsOf, listStored, pinnedHosts, readKnownHosts, splitTarget, storedGroups } from './store.js';
import { CONTAINER_SSH_DIR, syncView } from './view.js';

export * from './keys.js';
export { deployKeyMount } from './mount.js';

// ── spawn, egress, sweep ──────────────────────────────────────────────────────

/** Before a container spawns: refresh the view, pin missing host keys, start the agent. */
registerSessionPrepareHook(async (agentGroupId) => {
  const keys = listStored(agentGroupId);
  if (!keys.length) return;
  const pinned = pinnedHosts(readKnownHosts(agentGroupId));
  for (const k of keys)
    for (const t of hopsOf(k.meta)) if (!pinned.has(splitTarget(t).host)) await pinTarget(agentGroupId, t, false);
  syncView(agentGroupId);
  await ensureAgent(agentGroupId);
});

// Only for an agent with a key: the view and socket are mounted only then.
registerContainerEnvResolver((agentGroupId): Record<string, string> =>
  listStored(agentGroupId).length ? { SSH_AUTH_SOCK: `${CONTAINER_SSH_DIR}/agent.sock` } : {},
);

/**
 * The egress filter lets an agent reach every target of its own keys, port 22,
 * directly (SSH is not TLS, so not through the credential gateway). A server
 * reached through a jump host is listed too: the container may have no route
 * to it, and then the tunnel simply goes unused. Targets an install admin set
 * may resolve to a private address; a scoped admin's may not, the same line
 * the install allowlist draws for direct tunnels.
 */
registerKeyTargets(async (agentGroupId) =>
  listStored(agentGroupId).flatMap((k) =>
    hopsOf(k.meta).map((t) => ({
      host: splitTarget(t).host,
      port: 22,
      allowPrivate: k.meta.targetSetBy === 'install',
    })),
  ),
);

// Agents of groups with no running container are stopped; the first pass also
// rewrites every group's view (and memory note, which names keys, not paths).
let backfilled = false;
registerModuleSweep('deploy-keys-agents', async () => {
  await sweepAgents(groupIsLive);
  if (backfilled) return;
  backfilled = true;
  const known = new Set((await getAllAgentGroups()).map((g) => g.id));
  for (const id of storedGroups()) {
    if (!known.has(id) || !listStored(id).length) continue;
    try {
      syncView(id);
      const { refreshCredentialNote } = await import('../tool-secrets/index.js');
      const { realOnecliAdmin } = await import('../user-credentials/onecli-admin.js');
      await refreshCredentialNote(realOnecliAdmin, id);
    } catch (err) {
      log.warn('Deploy key: start-up refresh failed', { agentGroupId: id, err: String(err) });
    }
  }
});

process.once('exit', stopAllAgents);
