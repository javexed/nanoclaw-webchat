// Agent workloads: Compose stacks that run under an agent, on this host or a worker machine.
// Registers `ncl workloads`, the reconcile loop (preflight, network joins,
// expiry, disk, backups), the agent's own service addresses with the egress
// filter (so its proxied HTTP reaches its own services) and the registries
// an owner opted its builds into, and the inbound gateway that publishes
// apps to people. Nothing starts unless NANOCLAW_WORKLOADS=1 and the
// preflight passes (preflight.ts); the gateway also needs its own settings.
import { registerBuildRegistries, registerOwnNetworks } from '../../channels/webchat/egress-filter.js';
import { registerWorkloadTunnel } from '../../channels/webchat/workload-tunnel.js';
import { log } from '../../log.js';
import { registerModuleSweep } from '../../module-sweep.js';
import { registerOpenViaFilter } from '../container-egress/index.js';
import { isLinked, openWorkerTcp, whenLinked } from '../machines/links.js';
import './cli.js';
import { tickGateway } from './gateway/index.js';
import { tickCloudflare } from './cloudflare/index.js';
import { tickPorts } from './port/index.js';
import { tickTailnet } from './tailnet/index.js';
import { pruneRoutes } from './publish.js';
import { reconcileWorkloads } from './reconcile.js';
import { sleepSweep, wakeOnUse, wakeWorkload } from './sleep.js';
import { workloadsSwitchedOn } from './settings.js';
import { buildRegistries, listWorkloads, workloadsReady } from './store.js';
import { ensureWatcher } from './watch.js';
import { askWorkerProbe } from './worker-isolation.js';

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

// An Open agent with a stack on a worker uses the egress filter as its proxy
// (container-egress), the only way to that stack's addresses; at its next start.
registerOpenViaFilter(async (agentGroupId) => {
  if (!(await workloadsReady())) return false;
  return (await listWorkloads({ agentGroupId })).some((w) => w.state !== 'deleted' && w.node !== 'local');
});

// The agent's proxy (egress filter) asks here for every request to its own
// stacks. A stack on a worker: its addresses exist there only, so it is
// reached over the link.
registerWorkloadTunnel(async (host, port) => {
  if (!(await workloadsReady())) return null;
  const w = (await listWorkloads()).find((x) => Object.values(x.addresses).includes(host));
  if (!w) return null;
  // Every request to a stack, here or on a worker, counts as its traffic. A
  // sleeping one wakes (sleep.ts), and the agent's request waits for it (a
  // minute at most) rather than dialling stopped containers.
  if ((await wakeOnUse(w.id)) === 'starting')
    await Promise.race([wakeWorkload(w.id), new Promise((r) => setTimeout(r, WAKE_WAIT_MS).unref())]);
  if (w.node === 'local' || !isLinked(w.node)) return null;
  return () => openWorkerTcp(w.node, host, port);
});

registerBuildRegistries(buildRegistries);

const WAKE_WAIT_MS = 60_000;

// Idle stacks sleep (sleep.ts), checked every five minutes.
let lastSleepSweep = 0;
registerModuleSweep('workloads-sleep', async () => {
  if (Date.now() - lastSleepSweep < 5 * 60_000 || !workloadsSwitchedOn() || !(await workloadsReady())) return;
  lastSleepSweep = Date.now();
  await sleepSweep();
});

// A worker that links runs its isolation check with the helper image sent from
// here; until it passes, nothing is placed on it (placement.ts).
whenLinked(async (machineId) => {
  if (!workloadsSwitchedOn() || !(await workloadsReady())) return;
  await askWorkerProbe(machineId).catch((err) =>
    log.warn('Worker isolation check could not be asked for', { machineId, err: String(err).slice(0, 300) }),
  );
});

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
  await tickPorts(on).catch((err) => log.warn('Tailnet ports route: sweep failed', { err: String(err).slice(0, 300) }));
  await tickGateway(on);
});
