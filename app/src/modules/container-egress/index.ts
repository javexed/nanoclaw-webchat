/**
 * Per-agent-group network egress — one policy for every agent
 * (channels/webchat/egress-policy.ts):
 *
 *   'open'        anything. Chosen explicitly (stored as 'open').
 *   'host-only'   "Allowlist": the model, central's own services and the
 *                 install allowlist. What an UNSET mode means.
 *   'none'        "Model only": the model and central's own services.
 *
 * Both filtered modes put the container on the internal lockdown network,
 * whose host.docker.internal is central's egress filter; the filter applies
 * the group's mode per connection (so switching between the two filtered
 * modes applies at once). Only Open changes the network, at the next start.
 *
 * Fail closed. A network resolver that throws makes the seam fall back to the
 * built-in rules, which without the install flag means an OPEN network — so
 * any failure here returns `--network none` instead: the agent cannot reach
 * its model and fails visibly, rather than running unfiltered.
 *
 * TWO SEAMS, because the resolver is synchronous and the answer is in the
 * database: a prepare hook (async) reads and caches the mode; the resolver
 * (sync, called by the driver) reads the cache.
 */
import { registerNetworkPolicyResolver, registerSessionPrepareHook } from '../../seam/index.js';
import { EGRESS_LOCKDOWN, EGRESS_NETWORK } from '../../config.js';
import { ensureEgressNetwork, egressBridgeAddress, egressNetworkArgs } from '../../egress-lockdown.js';
import { log } from '../../log.js';
import { agentContainerName } from '../../drivers/docker-driver.js';
import {
  defaultFilterDeps,
  ensureEgressFilter,
  registerFilteredContainer,
} from '../../channels/webchat/egress-filter.js';
import { groupEgressMode, modelPassthroughs, type EgressMode } from '../../channels/webchat/egress-policy.js';
import { mcpRelayTarget } from '../../channels/webchat/mcp-relay.js';
import { gatewayHostForCentral } from '../../channels/webchat/runner-relay.js';

/**
 * agentGroupId -> mode, filled by the prepare hook.
 *
 * Keyed by the group, and the SPEC's key carries the real agent-group id (the
 * gateway's key is the credential identity, which is a different thing and can
 * be a derived per-member value). Reading the wrong one here would hand a
 * per-member session the wrong network.
 */
const modes = new Map<string, EgressMode>();

/**
 * Host-local model endpoints (Ollama, LiteLLM on the host), refreshed by the
 * prepare hook. A container dials these DIRECTLY (its NO_PROXY names the
 * host), so on the lockdown network they must be listeners on the bridge
 * address that forward to the host — the allowlist alone would never reach them.
 */
let passthroughs: Array<{ port: number; target: { host: string; port: number } }> = [];

registerSessionPrepareHook(async (agentGroupId): Promise<void> => {
  try {
    passthroughs = await modelPassthroughs();
  } catch (err) {
    log.warn('Egress: could not read the model registry; keeping the known pass-throughs', { err: String(err) });
  }
  // The relay's own decision, so both paths agree (and both fail closed).
  modes.set(agentGroupId, await groupEgressMode(agentGroupId));
});

/** The gateway the container's proxy URL names, as central reaches it — the filter forwards there. */
export function gatewayFromSpec(env: Record<string, string> | undefined): { host: string; port: number } | null {
  const raw = env?.HTTPS_PROXY ?? env?.HTTP_PROXY ?? env?.https_proxy ?? env?.http_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const port = Number(u.port || 80);
    return { host: gatewayHostForCentral(u.hostname), port };
  } catch {
    return null;
  }
}

/** The network arguments for a filtered agent; exported for tests. Throws on any failure (the resolver turns that into no network). */
export function filteredNetworkArgs(
  spec: Parameters<Parameters<typeof registerNetworkPolicyResolver>[0]>[0],
): string[] {
  const agent = spec.containers.find((c) => c.role === 'agent') ?? spec.containers[0];
  // The credential gateway's proxy URL arrives in the contributed lane, not in
  // `env` — reading only `env` found nothing and (correctly, but uselessly)
  // started every filtered agent with no network.
  const gateway = gatewayFromSpec({ ...(agent?.contributedEnv ?? {}), ...(agent?.env ?? {}) });
  if (!gateway) throw new Error('the agent has no proxy URL to filter (the credential gateway contributed none)');
  // The spec's declared gateway access: which container to keep off the
  // network, and which endpoint name the agent's proxy URL uses.
  ensureEgressNetwork(spec.networkAccess, true);
  const bridge = egressBridgeAddress();
  const relay = mcpRelayTarget();
  ensureEgressFilter(
    bridge,
    gateway.port,
    defaultFilterDeps(EGRESS_NETWORK, () => gateway),
    [
      { port: relay.port, target: relay },
      // The proxy and relay ports are spoken for; a model on one of them is misconfigured, not passed through.
      ...passthroughs.filter((p) => p.port !== gateway.port && p.port !== relay.port),
    ],
  );
  registerFilteredContainer(agentContainerName(spec), {
    agentGroupId: spec.key.agentGroupId,
    sessionId: spec.key.sessionId ?? '',
  });
  return egressNetworkArgs(spec.networkAccess);
}

registerNetworkPolicyResolver((spec) => {
  // Not seen by the prepare hook (it failed, or this spawn skipped it): the
  // default, which is the allowlist — never open by omission.
  const mode = modes.get(spec.key.agentGroupId) ?? 'host-only';
  // Open gets an ordinary network — unless the install-wide lockdown is on,
  // in which case it too goes behind the filter (whose policy lets an open
  // group through): the built-in lockdown path would put it on the network
  // without starting the filter or registering it, i.e. with no working proxy.
  if (mode === 'open' && !EGRESS_LOCKDOWN) return null;
  try {
    const args = filteredNetworkArgs(spec);
    log.info('Egress: filtered', { agentGroupId: spec.key.agentGroupId, mode });
    return args;
  } catch (err) {
    log.error('Egress: could not put the agent behind the egress filter — starting it with no network', {
      agentGroupId: spec.key.agentGroupId,
      mode,
      err: String((err as Error)?.message ?? err),
    });
    return ['--network', 'none'];
  }
});
