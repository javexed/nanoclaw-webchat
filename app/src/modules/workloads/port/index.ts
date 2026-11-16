/**
 * The tailnet ports route (docs/webchat/workloads.md, "Tailnet ports route").
 * Each published app gets one port on this machine's own tailnet name:
 * `https://<node>.<tailnet>.ts.net:9001`. A browser treats another port as
 * another origin, so the app's pages cannot act as NanoClaw, and NanoClaw
 * refuses actions from same-site pages (request-guard.ts actionAllowed).
 *
 * Tailscale serve, set up once by the owner for the whole range
 * (deploy/workloads-tailnet-ports.sh), terminates HTTPS on each port and
 * forwards it to the gateway's listener for that port on 127.0.0.1, adding
 * `Tailscale-User-Login` for a person's device. The gateway believes that
 * header only on those listeners (a request whose peer is loopback). NanoClaw
 * never changes Tailscale's config: it reads it, and hands each app a port
 * that is set up, tailnet-only, and free.
 *
 * Apps on this route share one host name, so they share cookies: a cookie is
 * sent to every port of the name. NanoClaw's own sign-in cookie is cut from
 * what an app receives and refused when an app sets it (gateway/caddy.ts).
 * Apps that must keep cookies from each other belong on the tailnet route.
 */
import { execFile } from 'child_process';

import { log } from '../../../log.js';
import type { RunResult, TailscaleRunner } from '../../../channels/webchat/tailscale-serve.js';
import { gatewaySettings, type GatewaySettings } from '../gateway/config.js';
import { tailnetIdentity } from '../gateway/identity.js';
import { registerPublishingRoute } from '../gateway/publishing.js';
import { listRoutes, type AppRoute } from '../routes.js';
import { workloadsSwitchedOn } from '../settings.js';
import { portSettings, type PortSettings } from './config.js';
import { serveView, type ServeView } from './serve.js';
import { loadPorts, pickPort, savePorts, type PortState } from './state.js';

export interface PortDeps {
  settings: () => PortSettings;
  gateway: () => GatewaySettings;
  workloadsOn: () => boolean;
  tailscale: TailscaleRunner;
  routes: () => Promise<AppRoute[]>;
  load: () => PortState;
  save: (s: PortState) => void;
  now: () => number;
}

const run: TailscaleRunner = (args) =>
  new Promise<RunResult>((resolve) =>
    execFile('tailscale', args, { timeout: 8000 }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        notFound: !!err && (err as NodeJS.ErrnoException).code === 'ENOENT',
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      }),
    ),
  );

const realDeps = (): PortDeps => ({
  settings: () => portSettings(),
  gateway: () => gatewaySettings(),
  workloadsOn: workloadsSwitchedOn,
  tailscale: run,
  routes: () => listRoutes(),
  load: loadPorts,
  save: savePorts,
  now: Date.now,
});

let deps: PortDeps | null = null;
const d = (): PortDeps => (deps ??= realDeps());

/** A port given for a card nobody approved is given back after this. */
export const UNCLAIMED_MS = 7 * 24 * 3600_000;

// --- Status ---------------------------------------------------------------

export type PortStatus =
  | { state: 'off'; warnings: string[] }
  | { state: 'connected'; warnings: string[] }
  | { state: 'missing'; missing: string; warnings: string[] };

let status: PortStatus = { state: 'off', warnings: [] };
let serve: ServeView = { dns: null, usable: [], problems: [], missing: [] };

/** For the Admin GUI's status line. */
export const portStatus = (): PortStatus => status;

/** The ports the setup script still has to add, as `9001-9010`; '' when there are none. */
export function setupRange(): string {
  const st = d().settings();
  return st.on && st.ok && serve.dns && serve.missing.length ? st.range : '';
}

async function computeStatus(): Promise<PortStatus> {
  const x = d();
  const st = x.settings();
  serve = { dns: null, usable: [], problems: [], missing: [] };
  if (!st.on) return { state: 'off', warnings: [] };
  const missing = (m: string, warnings: string[] = []): PortStatus => ({ state: 'missing', missing: m, warnings });
  if (!st.ok) return missing(st.reason);
  if (!x.workloadsOn()) return missing('workloads are off on this host (NANOCLAW_WORKLOADS=1)');
  const g = x.gateway();
  if (!g.on) return missing('the app gateway is off (set NANOCLAW_WORKLOAD_GATEWAY_PORT)');
  if (!g.ok) return missing(g.reason);
  if (st.ports.includes(g.cfg.port) || st.ports.includes(g.cfg.internalPort))
    return missing(
      `the ports ${st.range} clash with the app gateway’s own (${g.cfg.port}, ${g.cfg.internalPort}): pick another NANOCLAW_WORKLOAD_PORTS`,
    );
  serve = await serveView(x.tailscale, st.ports);
  if (!serve.dns) return missing('Tailscale is not running on this host');
  const warnings = serve.problems.map((p) => p.problem);
  if (!serve.usable.length)
    return missing(
      serve.missing.length
        ? `the ports are not set up on the tailnet (sudo bash deploy/workloads-tailnet-ports.sh --ports ${st.range})`
        : `none of the ports ${st.range} can be used: ${warnings.join('; ')}`,
      serve.missing.length ? warnings : [],
    );
  if (serve.missing.length)
    warnings.push(`${serve.missing.length} of the ports ${st.range} are not set up on the tailnet yet`);
  return { state: 'connected', warnings };
}

async function refreshStatus(): Promise<PortStatus> {
  const prev = status;
  status = await computeStatus().catch((err: unknown): PortStatus => ({
    state: 'missing',
    missing: `the ports check could not run: ${String((err as Error).message ?? err).slice(0, 200)}`,
    warnings: [],
  }));
  if (status.state === 'missing' && (prev.state !== 'missing' || prev.missing !== status.missing))
    log.warn('Tailnet ports route not available', { missing: status.missing });
  else if (status.state === 'connected' && prev.state !== 'connected')
    log.info('Tailnet ports route connected', { ports: serve.usable.length });
  return status;
}

/** Check again now, after an owner changed something in Admin → Publishing. */
export const refreshPortStatus = (): Promise<PortStatus> => refreshStatus();

// --- Ports ----------------------------------------------------------------

let held: PortState | null = null;
const state = (): PortState => (held ??= d().load());

function addressFor(app: string): string | null {
  if (status.state !== 'connected' || !serve.dns) return null;
  const s = state();
  const port = pickPort(s, app, serve.usable);
  if (port === null) return null;
  if (s.apps[app]?.port !== port) {
    s.apps[app] = { port, at: d().now() };
    d().save(s);
  }
  return `${serve.dns}:${port}`;
}

function release(app: string): void {
  const s = state();
  if (!s.apps[app]) return;
  delete s.apps[app];
  d().save(s);
}

/** Give back the ports of apps that are no longer on this route and not waiting on a card. */
async function releaseUnused(): Promise<void> {
  const s = state();
  const mine = new Set((await d().routes()).filter((r) => r.kind === 'port').map((r) => r.app));
  const now = d().now();
  let changed = false;
  for (const [app, v] of Object.entries(s.apps)) {
    if (mine.has(app) || now - v.at < UNCLAIMED_MS) continue;
    delete s.apps[app];
    changed = true;
  }
  if (changed) d().save(s);
}

/** One sweep: check the route and give back unused ports. */
export async function tickPorts(switchedOn = true): Promise<void> {
  if (!switchedOn) {
    status = { state: 'off', warnings: [] };
    return;
  }
  await refreshStatus();
  if (status.state === 'connected') await releaseUnused();
}

async function edgeState(route: AppRoute): Promise<{ ready: boolean; problem?: string }> {
  const port = state().apps[route.app]?.port;
  if (port === undefined || !serve.usable.includes(port))
    return { ready: false, problem: 'its port is not set up on the tailnet' };
  return { ready: true };
}

registerPublishingRoute({
  kind: 'port',
  label: 'a port on NanoClaw’s tailnet name',
  enabled: async () => status.state === 'connected',
  hostnameFor: async (app) => addressFor(app),
  // Serve reaches the gateway's port listeners from loopback; nothing else may speak for a person there.
  identify: tailnetIdentity({ trustedPeers: async () => ['127.0.0.1', '::1'] }),
  detach: async (route) => release(route.app),
  edgeState,
});

export function __setPortDepsForTest(p: Partial<PortDeps> | null): void {
  deps = p ? { ...realDeps(), ...p } : null;
  status = { state: 'off', warnings: [] };
  serve = { dns: null, usable: [], problems: [], missing: [] };
  held = null;
}

export const __refreshPortStatusForTest = (): Promise<PortStatus> => refreshStatus();
