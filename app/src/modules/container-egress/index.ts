/**
 * Per-agent-group network egress.
 *
 *   'open' (or NULL)  full egress — the default, tailnet-first product.
 *   'host-only'       internal docker network: host services (OneCLI, LiteLLM,
 *                     the MCP relay) reachable, the internet not.
 *   'none'            no network at all.
 *
 * WHY THIS MODULE EXISTS. The install-wide egress lockdown is upstream's now —
 * the Docker driver arms it itself. What upstream does not have is the
 * PER-GROUP choice, and after the driver seam landed there was nowhere left to
 * express it: argv assembly moved behind the driver, `container_configs.egress`
 * kept being written by the UI, and nothing read it. A group set to
 * `host-only` was quietly running with full egress. This reconnects the column
 * to the container.
 *
 * TWO SEAMS, because the resolver is synchronous and the answer is in the
 * database:
 *
 *   1. A prepare hook (async, runs before the spawn composes anything) reads
 *      the group's egress mode and caches it.
 *   2. The network-policy resolver (sync, called by the driver) reads that
 *      cache.
 *
 * That ordering is the prepare hook's stated contract — "hooks run BEFORE
 * identity/env resolution so anything a hook provisions is ready for the
 * resolvers" — and it is why the resolver never needs to await.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { registerNetworkPolicyResolver } from '../../drivers/index.js';
import { registerSessionPrepareHook } from '../../container-runtime.js';
import { ensureEgressNetwork, egressNetworkArgs } from '../../egress-lockdown.js';
import { log } from '../../log.js';

export type EgressMode = 'open' | 'host-only' | 'none';

/**
 * agentGroupId -> mode, filled by the prepare hook.
 *
 * Keyed by the group, and the SPEC's key carries the real agent-group id (the
 * gateway's key is the credential identity, which is a different thing and can
 * be a derived per-member value). Reading the wrong one here would hand a
 * per-member session the wrong network.
 */
const modes = new Map<string, EgressMode>();

function normalize(value: unknown): EgressMode {
  return value === 'host-only' || value === 'none' ? value : 'open';
}

registerSessionPrepareHook(async (agentGroupId): Promise<void> => {
  try {
    modes.set(agentGroupId, normalize((await getContainerConfig(agentGroupId))?.egress));
  } catch (err) {
    // Leave any previous answer in place rather than overwriting it with a
    // guess. A read failure is not evidence that the operator opened egress.
    log.warn('Egress mode lookup failed; keeping the cached value', { agentGroupId, err: String(err) });
  }
});

registerNetworkPolicyResolver((spec) => {
  const mode = modes.get(spec.key.agentGroupId);
  // Unknown group: abstain. The built-in rules still arm the install-wide
  // lockdown, so abstaining is not the same as opening egress.
  if (!mode || mode === 'open') return null;

  if (mode === 'none') return ['--network', 'none'];

  // host-only: force the internal network even when the install-wide flag is
  // off — that is what per-group means. ensureEgressNetwork(true) creates it
  // and throws rather than returning false, so a failure here cannot
  // downgrade the session to open egress.
  ensureEgressNetwork(true);
  log.info('Egress: host-only (per-group)', { agentGroupId: spec.key.agentGroupId });
  return egressNetworkArgs();
});
