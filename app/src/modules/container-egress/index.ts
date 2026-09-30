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
import { execFile } from 'child_process';
import net from 'net';
import type { Duplex } from 'stream';

import { registerNetworkPolicyResolver, registerSessionPrepareHook } from '../../seam/index.js';
import { EGRESS_LOCKDOWN, EGRESS_NETWORK, INSTALL_SLUG } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { ensureEgressNetwork, egressBridgeAddress, egressNetworkArgs } from '../../egress-lockdown.js';
import { log } from '../../log.js';
import { agentContainerName } from '../../drivers/docker-driver.js';
import { registerSidecarEgressCheck } from '../../drivers/index.js';
import {
  defaultFilterDeps,
  ensureEgressFilter,
  registerFilteredContainer,
  serveProxyClient,
  type Caller,
} from '../../channels/webchat/egress-filter.js';
import { registerRelayedContainer } from '../../channels/webchat/exec-relay.js';
import { groupEgressMode, modelPassthroughs, type EgressMode } from '../../channels/webchat/egress-policy.js';
import { mcpRelayTarget } from '../../channels/webchat/mcp-relay.js';
import { gatewayHostForCentral } from '../../channels/webchat/gateway-connect.js';

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
 * address that forward to the host — the allowlist alone would never reach
 * them. Each connection is held to the caller's own policy (egress-filter.ts).
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

/**
 * WEBCHAT_EXEC_RELAY=1: filtered agents get no network at all and reach out
 * over a pipe central opens (exec-relay.ts), instead of the lockdown network
 * and the filter's host listener. Same policy, same gateway, same credential;
 * nothing for a host firewall to block.
 */
export const execRelayEnabled = (): boolean => (process.env.WEBCHAT_EXEC_RELAY ?? '').trim() === '1';

/** Serve one relayed stream: the proxy port through the filter's own logic, central's services straight through. */
function relayRoute(
  caller: Caller,
  gateway: { host: string; port: number },
  services: Map<number, { host: string; port: number }>,
) {
  const deps = { ...defaultFilterDeps(EGRESS_NETWORK, () => gateway), identify: async () => caller };
  return (port: number, stream: Duplex): void => {
    if (port === gateway.port) {
      void serveProxyClient(stream, deps).catch(() => stream.destroy());
      return;
    }
    const target = services.get(port);
    if (!target) return void stream.destroy();
    const up = net.connect(target);
    up.on('error', () => stream.destroy());
    stream.on('error', () => up.destroy());
    stream.pipe(up);
    up.pipe(stream);
  };
}

/** Central's own services a relayed container dials directly: the MCP relay and host-local models. */
function relayServices(gatewayPort: number): Map<number, { host: string; port: number }> {
  const relay = mcpRelayTarget();
  const services = new Map<number, { host: string; port: number }>([[relay.port, relay]]);
  for (const p of passthroughs) if (p.port !== gatewayPort && !services.has(p.port)) services.set(p.port, p.target);
  return services;
}

/** The network arguments for an exec-relayed agent; exported for tests. Throws when there is no gateway to relay to. */
export function execRelayNetworkArgs(
  spec: Parameters<Parameters<typeof registerNetworkPolicyResolver>[0]>[0],
): string[] {
  const agent = spec.containers.find((c) => c.role === 'agent') ?? spec.containers[0];
  const gateway = gatewayFromSpec({ ...(agent?.contributedEnv ?? {}), ...(agent?.env ?? {}) });
  if (!gateway) throw new Error('the agent has no proxy URL to relay (the credential gateway contributed none)');
  const services = relayServices(gateway.port);
  const caller = { agentGroupId: spec.key.agentGroupId, sessionId: spec.key.sessionId ?? '' };
  registerRelayedContainer(agentContainerName(spec), {
    ports: [gateway.port, ...services.keys()],
    route: relayRoute(caller, gateway, services),
  });
  // The endpoint name the proxy URL uses now means the container's own loopback, where the forwarder listens.
  return ['--network', 'none', `--add-host=${spec.networkAccess.endpoint}:127.0.0.1`];
}

/**
 * After a restart, running relayed containers were never registered in this
 * process: find them (no network, the endpoint on loopback) and relay them
 * again from their labels and proxy URL.
 */
function adoptRelayedContainers(): void {
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve) =>
      execFile(CONTAINER_RUNTIME_BIN, args, { timeout: 15_000 }, (err, out) => resolve(err ? '' : String(out))),
    );
  void (async () => {
    const names = (
      await run([
        'ps',
        '--filter',
        `label=nanoclaw-install=${INSTALL_SLUG}`,
        '--filter',
        'label=nanoclaw-role=agent',
        '--format',
        '{{.Names}}',
      ])
    )
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);
    for (const name of names) {
      const out = await run([
        'inspect',
        '--format',
        '{{.HostConfig.NetworkMode}}\t{{json .HostConfig.ExtraHosts}}\t{{index .Config.Labels "nanoclaw-group"}}\t{{index .Config.Labels "nanoclaw-session"}}\t{{json .Config.Env}}',
        name,
      ]);
      const [mode, hostsJson, group, session, envJson] = out.trim().split('\t');
      let hosts: string[] = [];
      let envList: string[] = [];
      try {
        hosts = (JSON.parse(hostsJson) as string[] | null) ?? [];
        envList = (JSON.parse(envJson) as string[] | null) ?? [];
      } catch {
        continue;
      }
      if (mode !== 'none' || !hosts.some((h) => h.endsWith(':127.0.0.1')) || !group || group === '<no value>') continue;
      const env = Object.fromEntries(envList.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
      const gateway = gatewayFromSpec(env);
      if (!gateway) continue;
      const services = relayServices(gateway.port);
      const caller = { agentGroupId: group, sessionId: session && session !== '<no value>' ? session : '' };
      registerRelayedContainer(name, {
        ports: [gateway.port, ...services.keys()],
        route: relayRoute(caller, gateway, services),
      });
      log.info('Exec relay: adopted a running container', { container: name });
    }
  })().catch((err: unknown) => log.warn('Exec relay: adoption scan failed', { err: String(err) }));
}
if (execRelayEnabled()) setTimeout(adoptRelayedContainers, 0).unref?.();

/** The network arguments for a filtered agent; exported for tests. Throws on any failure (the resolver turns that into no network). */
export function filteredNetworkArgs(
  spec: Parameters<Parameters<typeof registerNetworkPolicyResolver>[0]>[0],
): string[] {
  const agent = spec.containers.find((c) => c.role === 'agent') ?? spec.containers[0];
  // The credential gateway's proxy URL arrives in the contributed lane, not `env`.
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
    [{ port: relay.port, target: relay }],
    // Held to each caller's policy, not open to every agent on the network. The
    // proxy and relay ports are spoken for; a model on one of them is misconfigured.
    passthroughs.filter((p) => p.port !== gateway.port && p.port !== relay.port),
  );
  registerFilteredContainer(agentContainerName(spec), {
    agentGroupId: spec.key.agentGroupId,
    sessionId: spec.key.sessionId ?? '',
  });
  return egressNetworkArgs(spec.networkAccess);
}

/**
 * Whether this group's agent goes behind the egress filter — the resolver's
 * own decision, without its side effects (no listener, no registration).
 */
export function wouldFilter(agentGroupId: string): boolean {
  // Not seen by the prepare hook (it failed, or this spawn skipped it): the
  // default, which is the allowlist — never open by omission.
  const mode = modes.get(agentGroupId) ?? 'host-only';
  // Open gets an ordinary network — unless the install-wide lockdown is on,
  // in which case it too goes behind the filter (whose policy lets an open
  // group through): the built-in lockdown path would put it on the network
  // without starting the filter or registering it, i.e. with no working proxy.
  return mode !== 'open' || EGRESS_LOCKDOWN;
}

// A sidecar gateway's namespace would bypass the filter: the driver refuses
// such an agent when this says it is filtered.
registerSidecarEgressCheck((spec) => wouldFilter(spec.key.agentGroupId));

registerNetworkPolicyResolver((spec) => {
  if (!wouldFilter(spec.key.agentGroupId)) return null;
  const mode = modes.get(spec.key.agentGroupId) ?? 'host-only';
  try {
    const relayed = execRelayEnabled();
    const args = relayed ? execRelayNetworkArgs(spec) : filteredNetworkArgs(spec);
    log.info(relayed ? 'Egress: exec relay' : 'Egress: filtered', { agentGroupId: spec.key.agentGroupId, mode });
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
