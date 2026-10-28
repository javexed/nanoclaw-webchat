// Agent workloads: Compose stacks that run under an agent on this host.
// Registers `ncl workloads`, the reconcile loop (preflight, network joins,
// expiry, disk, backups), the agent's own service addresses with the egress
// filter (so its proxied HTTP reaches its own services) and the registries
// an owner opted its builds into, and the inbound gateway that publishes
// apps to people. Nothing starts unless NANOCLAW_WORKLOADS=1 and the
// preflight passes (preflight.ts); the gateway also needs its own settings.
import { registerBuildRegistries, registerOwnNetworks } from '../../channels/webchat/egress-filter.js';
import { log } from '../../log.js';
import { registerModuleSweep } from '../../module-sweep.js';
import './cli.js';
import { tickGateway } from './gateway/index.js';
import { tickCloudflare } from './cloudflare/index.js';
import { tickTailnet } from './tailnet/index.js';
import { pruneRoutes } from './publish.js';
import { reconcileWorkloads } from './reconcile.js';
import { workloadsSwitchedOn } from './settings.js';
import { buildRegistries, listWorkloads, workloadsReady } from './store.js';
import { ensureWatcher } from './watch.js';

registerModuleSweep('workloads-reconcile', async () => {
  if (!workloadsSwitchedOn() || !(await workloadsReady())) return;
  ensureWatcher();
  await reconcileWorkloads();
});

// Only the addresses its services hold, not the whole /24: .1 there is this
// host, which the filter would otherwise dial from the host side.
registerOwnNetworks(async (agentGroupId) => {
  if (!(await workloadsReady())) return [];
  return (await listWorkloads({ agentGroupId })).flatMap((w) => Object.values(w.addresses).map((a) => `${a}/32`));
});

registerBuildRegistries(buildRegistries);

// The inbound gateway for published apps (gateway/): started, kept in step
// with the published apps, or taken down when switched off.
registerModuleSweep('workloads-gateway', async () => {
  const on = workloadsSwitchedOn() && (await workloadsReady());
  if (on) await pruneRoutes();
  // The routes first: the gateway listens on their edge network's address.
  await tickTailnet(on).catch((err) => log.warn('Tailnet route: sweep failed', { err: String(err).slice(0, 300) }));
  await tickCloudflare(on).catch((err) =>
    log.warn('Cloudflare route: sweep failed', { err: String(err).slice(0, 300) }),
  );
  await tickGateway(on);
});
