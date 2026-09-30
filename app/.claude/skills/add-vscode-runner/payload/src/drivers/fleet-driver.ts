/**
 * Fleet driver — kind `fleet`. Every session runs through the docker driver,
 * here on central. An agent group placed on a paired machine runs here too:
 * the machine serves its project through the laptop tools (runner-tools.ts),
 * which the agent reaches through the MCP relay — so the one thing this adds
 * is making sure that relay is up before such a session starts.
 *
 * Kept as its own kind so installs set to `NANOCLAW_RUNTIME_DRIVER=fleet`
 * keep starting. Registered via `installed.ts` (append-only barrel). The
 * docker factory is resolved when the fleet factory RUNS — the barrel is
 * imported before index.ts registers docker.
 */
import { startMcpRelay } from '../channels/webchat/mcp-relay.js';
import { getPlacement, type RunnerPlacementRow } from '../channels/webchat/runner-registry.js';
import { log } from '../log.js';
import { getSessionDriverFactory, registerSessionDriver } from './driver-registry.js';
import type {
  DriverCapabilities,
  MountPolicy,
  SessionDriver,
  SessionEvent,
  SessionHandle,
  SessionSnapshot,
  SessionSpec,
  SessionWatch,
} from './types.js';

export const FLEET_DRIVER_KIND = 'fleet';

export type PlacementLookup = (agentGroupId: string) => Promise<RunnerPlacementRow | undefined>;

export class FleetSessionDriver implements SessionDriver {
  readonly kind = FLEET_DRIVER_KIND;

  constructor(
    private readonly local: SessionDriver,
    private readonly placementFor: PlacementLookup,
  ) {}

  capabilities(): DriverCapabilities {
    return this.local.capabilities();
  }
  async ensureReady(): Promise<void> {
    await this.local.ensureReady?.();
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    const placement = await this.placementFor(spec.key.agentGroupId).catch((err: unknown) => {
      log.warn('Fleet driver: placement lookup failed', { agentGroupId: spec.key.agentGroupId, err });
      return undefined;
    });
    // Placed on a machine: the agent reaches its laptop tools through the relay port.
    if (placement) startMcpRelay();
    return this.local.prepare(spec);
  }

  listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    return this.local.listSessions(installSlug);
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    return this.local.watchSessions(installSlug, onEvent);
  }

  async reapResidue(installSlug: string): Promise<void> {
    await this.local.reapResidue?.(installSlug);
  }
}

registerSessionDriver(FLEET_DRIVER_KIND, (policy: MountPolicy) => {
  const docker = getSessionDriverFactory('docker');
  if (!docker) throw new Error("fleet driver wraps 'docker', which is not registered");
  return new FleetSessionDriver(docker(policy), getPlacement);
});
