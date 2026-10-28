/**
 * The tailnet publishing route (docs/webchat/workloads.md, "Tailnet route").
 * Registers the `tailnet` route kind with the gateway and keeps one sidecar
 * per tailnet app in step with the published apps:
 *
 *   expose     mint a single-use tagged auth key, start the app's sidecar,
 *              wait until it is on the tailnet as <app>.<tailnet>.ts.net and
 *              serving; the key file is deleted as soon as it logged in
 *   unexpose   log the device out, remove the sidecar and its state, and
 *              remove the device from the tailnet through the API
 *   each sweep the same, for every app: a missing sidecar is started, a
 *              sidecar without an app is removed, devices the API could not
 *              remove before are removed now
 *
 * The route is on only while everything it needs is there (tailnetStatus):
 * the setting, the gateway listening on the edge address, the OAuth client in
 * the vault, the host rules for the edge network, and a working Tailscale API.
 */
import fs from 'fs';

import { log } from '../../../log.js';
import { realOnecliAdmin, type OnecliAdmin } from '../../user-credentials/onecli-admin.js';
import { gatewaySettings, type GatewaySettings } from '../gateway/config.js';
import { tailnetIdentity } from '../gateway/identity.js';
import { registerPublishingRoute, type PublishedApp } from '../gateway/publishing.js';
import { listRoutes, type AppRoute } from '../routes.js';
import { workloadsSwitchedOn } from '../settings.js';
import { realTailscaleHttp, TailscaleApi } from './api.js';
import { FIRST_HOST, LAST_HOST, tailnetSettings, type TailnetConfig, type TailnetSettings } from './config.js';
import { checkVault, type VaultCheck } from './credential.js';
import { ensureEdgeNetwork, evictStrangers, probeEdge, type EdgeIsolation } from './edge.js';
import {
  containerState,
  deviceStatus,
  hasState,
  listSidecars,
  prepareDir,
  realDocker,
  removeContainer,
  removeKeyFile,
  restartCount,
  runArgs,
  serving,
  sidecarDir,
  sidecarName,
  SOCKET,
  specHash,
  startContainer,
  writeKeyFile,
  type DeviceStatus,
  type DockerRun,
  type SidecarSpec,
} from './sidecar.js';
import { freeAddress, loadState, saveState, type SidecarRecord } from './state.js';

export interface TailnetDeps {
  docker: DockerRun;
  api: TailscaleApi;
  admin: OnecliAdmin;
  settings: () => TailnetSettings;
  gateway: () => GatewaySettings;
  workloadsOn: () => boolean;
  routes: () => Promise<AppRoute[]>;
  probe: (docker: DockerRun, cfg: TailnetConfig) => Promise<EdgeIsolation>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  uid: number;
  gid: number;
  /** How long a sidecar may take to come up on the tailnet and serve. */
  readyTimeoutMs: number;
}

const realDeps = (): TailnetDeps => ({
  docker: realDocker,
  api: new TailscaleApi(realTailscaleHttp),
  admin: realOnecliAdmin,
  settings: () => tailnetSettings(),
  gateway: () => gatewaySettings(),
  workloadsOn: workloadsSwitchedOn,
  routes: () => listRoutes(),
  probe: probeEdge,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
  uid: process.getuid?.() ?? 1000,
  gid: process.getgid?.() ?? 1000,
  readyTimeoutMs: 120_000,
});

let deps: TailnetDeps | null = null;
const d = (): TailnetDeps => (deps ??= realDeps());

// --- Status ---------------------------------------------------------------

export type TailnetStatus =
  | { state: 'off'; warnings: string[] }
  | { state: 'connected'; warnings: string[] }
  | { state: 'missing'; missing: string; warnings: string[] };

const VAULT_EVERY_MS = 10 * 60_000;
const PROBE_EVERY_MS = 30 * 60_000;
const API_EVERY_MS = 10 * 60_000;

let status: TailnetStatus = { state: 'off', warnings: [] };
let vault: { at: number; r: VaultCheck } | null = null;
let probe: { at: number; r: string | null } | null = null;
let api: { at: number; r: string | null } | null = null;
const routeProblems = new Map<string, string>();

/** For the Admin GUI's status line: `Connected`, or the one thing missing (and any warnings). */
export const tailnetStatus = (): TailnetStatus => status;

/** Check again now, after an owner changed something in Admin → Publishing. */
export const refreshTailnetStatus = (): Promise<TailnetStatus> => refreshStatus(true);

async function computeStatus(force = false): Promise<TailnetStatus> {
  const x = d();
  const st = x.settings();
  if (!st.on) return { state: 'off', warnings: [] };
  const missing = (m: string, warnings: string[] = []): TailnetStatus => ({ state: 'missing', missing: m, warnings });
  if (!st.ok) return missing(st.reason);
  if (!x.workloadsOn()) return missing('workloads are off on this host (NANOCLAW_WORKLOADS=1)');
  const g = x.gateway();
  if (!g.on) return missing('the app gateway is off (set NANOCLAW_WORKLOAD_GATEWAY_PORT)');
  if (!g.ok) return missing(g.reason);
  if (g.cfg.bind !== st.cfg.gateway)
    return missing(
      `the app gateway must listen on the edge address: set NANOCLAW_WORKLOAD_GATEWAY_BIND=${st.cfg.gateway}`,
    );
  const now = x.now();
  if (force || !vault || now - vault.at >= VAULT_EVERY_MS || !vault.r.ok) {
    const r = await checkVault(x.admin).catch(
      (err: unknown): VaultCheck => ({
        ok: false,
        missing: `OneCLI could not be asked: ${String((err as Error).message ?? err).slice(0, 200)}`,
        warnings: [],
      }),
    );
    vault = { at: now, r };
  }
  const warnings = [...vault.r.warnings];
  if (!vault.r.ok) return missing(vault.r.missing, warnings);
  if (force || !probe || now - probe.at >= PROBE_EVERY_MS || probe.r) {
    let r: string | null = null;
    try {
      if ((await x.probe(x.docker, st.cfg)) === 'open')
        r = `the host rules for the edge network are missing (sudo deploy/workloads-host-rules.sh --gateway ${st.cfg.gateway}:${g.cfg.port} --install-unit)`;
    } catch (err) {
      r = `the edge network check could not run: ${String((err as Error).message ?? err).slice(0, 200)}`;
    }
    probe = { at: now, r };
  }
  if (probe.r) return missing(probe.r, warnings);
  if (force || !api || now - api.at >= API_EVERY_MS || api.r) {
    const r = await x.api.accessToken().then(
      () => null,
      (err: unknown) => String((err as Error).message ?? err).slice(0, 200),
    );
    api = { at: now, r };
  }
  if (api.r) return missing(api.r, warnings);
  const pending = loadState().pendingDeletes.length;
  if (pending) warnings.push(`${pending} device${pending === 1 ? '' : 's'} still to be removed from the tailnet`);
  return { state: 'connected', warnings };
}

async function refreshStatus(force = false): Promise<TailnetStatus> {
  const prev = status;
  status = await computeStatus(force);
  if (status.state === 'missing' && (prev.state !== 'missing' || prev.missing !== status.missing))
    log.warn('Tailnet route not available', { missing: status.missing });
  else if (status.state === 'connected' && prev.state !== 'connected') log.info('Tailnet route connected');
  return status;
}

// --- Sidecars -------------------------------------------------------------

/** One sidecar change at a time: addresses and the state file are shared. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const hostnameOf = (app: string, cfg: TailnetConfig): string => `${app}.${cfg.domain}`;

function specFor(rec: SidecarRecord, cfg: TailnetConfig, gatewayPort: number): SidecarSpec {
  const x = d();
  return {
    routeId: rec.routeId,
    app: rec.app,
    address: rec.address,
    cfg,
    gatewayPort,
    dir: sidecarDir(rec.routeId),
    uid: x.uid,
    gid: x.gid,
  };
}

type Ready = { ok: true; status: DeviceStatus } | { ok: false; reason: string; status: DeviceStatus | null };

/** Wait until the sidecar is on the tailnet under the app's name, tagged, and serving. */
async function waitReady(name: string, hostname: string, tag: string, keyless: boolean): Promise<Ready> {
  const x = d();
  const until = x.now() + x.readyTimeoutMs;
  let last: DeviceStatus | null = null;
  let needsLogin = 0;
  while (x.now() < until) {
    const s = await deviceStatus(x.docker, name);
    if (s) last = s;
    if (s?.backendState === 'Running' && s.dnsName) {
      if (s.dnsName !== hostname) return { ok: false, reason: `name-taken:${s.dnsName}`, status: s };
      if (!s.tags.includes(tag)) return { ok: false, reason: 'untagged', status: s };
      if (await serving(x.docker, name, hostname)) return { ok: true, status: s };
    }
    if (
      keyless &&
      ((s?.backendState === 'NeedsLogin' && ++needsLogin >= 3) || (await restartCount(x.docker, name)) >= 2)
    )
      return { ok: false, reason: 'needs-login', status: s };
    await x.sleep(1000);
  }
  return { ok: false, reason: `timeout (${last?.backendState || 'no answer'})`, status: last };
}

async function deleteDeviceOrQueue(nodeId: string): Promise<void> {
  const x = d();
  try {
    await x.api.deleteDevice(nodeId);
    const st = loadState();
    if (st.pendingDeletes.includes(nodeId)) {
      st.pendingDeletes = st.pendingDeletes.filter((n) => n !== nodeId);
      saveState(st);
    }
  } catch (err) {
    log.warn('Tailnet: could not remove a device yet, will retry', { nodeId, err: String(err).slice(0, 200) });
    const st = loadState();
    if (!st.pendingDeletes.includes(nodeId)) st.pendingDeletes.push(nodeId);
    saveState(st);
  }
}

function wipeState(dir: string): void {
  fs.rmSync(`${dir}/state`, { recursive: true, force: true });
  fs.mkdirSync(`${dir}/state`, { recursive: true, mode: 0o700 });
}

function forget(routeId: string, patch?: Partial<SidecarRecord>): void {
  const st = loadState();
  if (!st.sidecars[routeId]) return;
  if (patch) st.sidecars[routeId] = { ...st.sidecars[routeId], ...patch };
  else delete st.sidecars[routeId];
  saveState(st);
}

/** A first login: a fresh single-use key, handed over as a file and deleted once the device is up. */
async function freshLogin(rec: SidecarRecord, spec: SidecarSpec, args: string[], hostname: string): Promise<void> {
  const x = d();
  const name = sidecarName(rec.app);
  await removeContainer(x.docker, name);
  if (rec.nodeId) {
    await deleteDeviceOrQueue(rec.nodeId);
    forget(rec.routeId, { nodeId: null });
  }
  wipeState(spec.dir);
  const key = await x.api.mintAuthKey(spec.cfg.tag, `nanoclaw app ${rec.app}`);
  let r: Ready;
  try {
    writeKeyFile(spec.dir, key.key);
    await startContainer(x.docker, name, args);
    r = await waitReady(name, hostname, spec.cfg.tag, false);
  } finally {
    removeKeyFile(spec.dir);
  }
  if (r.ok) {
    forget(rec.routeId, { nodeId: r.status.nodeId });
    log.info('Tailnet: app sidecar up', { app: rec.app, hostname });
    return;
  }
  // Undo: the key (if unused), the device (if it joined), the container and its state.
  await x.api.deleteAuthKey(key.id).catch(() => undefined);
  if (r.status?.nodeId) await deleteDeviceOrQueue(r.status.nodeId);
  await removeContainer(x.docker, name);
  wipeState(spec.dir);
  if (r.reason.startsWith('name-taken:'))
    throw new Error(
      `a device named ${rec.app} is already on the tailnet (the sidecar got ${r.reason.slice(11)}): remove it in the admin console or pick another app name`,
    );
  if (r.reason === 'untagged')
    throw new Error(`the sidecar joined without ${spec.cfg.tag}: check the tag and the OAuth client's tags`);
  throw new Error(`the sidecar did not come up on the tailnet: ${r.reason}`);
}

/** Make the app's sidecar exist, run and serve. Throws with what is wrong. */
async function ensureSidecar(route: AppRoute, cfg: TailnetConfig, gatewayPort: number): Promise<void> {
  const x = d();
  const st = loadState();
  let rec: SidecarRecord | undefined = st.sidecars[route.id];
  if (rec && rec.app !== route.app) {
    await removeSidecar(rec);
    rec = undefined;
  }
  if (!rec) {
    const address = freeAddress(loadState(), cfg.prefix, FIRST_HOST, LAST_HOST);
    if (!address) throw new Error('every tailnet sidecar address is taken');
    rec = { routeId: route.id, app: route.app, address, nodeId: null };
    const s2 = loadState();
    s2.sidecars[route.id] = rec;
    saveState(s2);
  }
  const spec = specFor(rec, cfg, gatewayPort);
  prepareDir(spec);
  const args = runArgs(spec);
  const name = sidecarName(rec.app);
  const hostname = hostnameOf(rec.app, cfg);
  const cs = await containerState(x.docker, name);
  const current = cs?.running === true && cs.spec === specHash(args);
  if (rec.nodeId && hasState(spec.dir)) {
    if (current) return;
    // A known device: (re)start from its state, no key.
    await startContainer(x.docker, name, args);
    const r = await waitReady(name, hostname, cfg.tag, true);
    if (r.ok) return;
    if (r.reason !== 'needs-login') throw new Error(`the sidecar did not come back: ${r.reason}`);
  }
  await freshLogin(rec, spec, args, hostname);
}

/** Log out, remove the container and state, remove the device from the tailnet. */
async function removeSidecar(rec: SidecarRecord): Promise<void> {
  const x = d();
  const name = sidecarName(rec.app);
  await x.docker(['exec', name, 'tailscale', `--socket=${SOCKET}`, 'logout'], 20_000).catch(() => undefined);
  await removeContainer(x.docker, name);
  if (rec.nodeId) await deleteDeviceOrQueue(rec.nodeId);
  fs.rmSync(sidecarDir(rec.routeId), { recursive: true, force: true });
  forget(rec.routeId);
  routeProblems.delete(rec.routeId);
  log.info('Tailnet: app sidecar removed', { app: rec.app });
}

function noteProblem(route: AppRoute, err: unknown): void {
  const msg = String((err as Error).message ?? err).slice(0, 300);
  if (routeProblems.get(route.id) !== msg) log.warn('Tailnet: app sidecar not up', { app: route.app, err: msg });
  routeProblems.set(route.id, msg);
}

/** Bring every tailnet app's sidecar up; remove sidecars without an app. */
async function reconcileSidecars(cfg: TailnetConfig, gatewayPort: number, connected: boolean): Promise<void> {
  const x = d();
  const wanted = (await x.routes()).filter((r) => r.kind === 'tailnet');
  const ids = new Set(wanted.map((r) => r.id));
  for (const rec of Object.values(loadState().sidecars)) if (!ids.has(rec.routeId)) await removeSidecar(rec);
  const names = new Set(wanted.map((r) => sidecarName(r.app)));
  for (const [name] of await listSidecars(x.docker)) if (!names.has(name)) await removeContainer(x.docker, name);
  if (!connected) return;
  for (const r of wanted) {
    try {
      await ensureSidecar(r, cfg, gatewayPort);
      routeProblems.delete(r.id);
    } catch (err) {
      noteProblem(r, err);
    }
  }
  for (const nodeId of loadState().pendingDeletes) await deleteDeviceOrQueue(nodeId);
}

/** Everything off: no sidecar keeps a device on the tailnet. */
async function teardown(): Promise<void> {
  const x = d();
  for (const rec of Object.values(loadState().sidecars)) await removeSidecar(rec);
  for (const [name] of await listSidecars(x.docker).catch(() => new Map<string, string>()))
    await removeContainer(x.docker, name);
}

/**
 * One pass, before the gateway's (the gateway listens on the edge network's
 * address, so the network must exist first).
 */
export async function tickTailnet(switchedOn = true): Promise<void> {
  const x = d();
  const st = x.settings();
  if (!switchedOn || !st.on) {
    status = { state: 'off', warnings: [] };
    if (Object.keys(loadState().sidecars).length) await serial(teardown);
    return;
  }
  if (!st.ok) {
    await refreshStatus();
    return;
  }
  await serial(async () => {
    await ensureEdgeNetwork(x.docker, st.cfg);
    await evictStrangers(x.docker);
    const s = await refreshStatus();
    const g = x.gateway();
    await reconcileSidecars(st.cfg, g.on && g.ok ? g.cfg.port : 0, s.state === 'connected');
  });
}

// --- The route kind -------------------------------------------------------

async function attach(route: AppRoute): Promise<void> {
  const st = d().settings();
  const g = d().gateway();
  if (!st.on || !st.ok || !g.on || !g.ok || status.state !== 'connected') return;
  await serial(() => ensureSidecar(route, st.cfg, g.cfg.port))
    .then(() => routeProblems.delete(route.id))
    .catch((err: unknown) => noteProblem(route, err));
}

async function detach(route: AppRoute): Promise<void> {
  await serial(async () => {
    const rec = loadState().sidecars[route.id];
    if (rec) await removeSidecar(rec);
  });
}

/** Only the app's own sidecar may speak for it. */
async function trustedPeers(app: PublishedApp): Promise<string[]> {
  const rec = loadState().sidecars[app.id];
  return rec && rec.app === app.app && rec.nodeId ? [rec.address] : [];
}

async function edgeState(route: AppRoute): Promise<{ ready: boolean; problem?: string }> {
  const rec = loadState().sidecars[route.id];
  const problem = routeProblems.get(route.id);
  return { ready: Boolean(rec?.nodeId) && !problem, ...(problem ? { problem } : {}) };
}

registerPublishingRoute({
  kind: 'tailnet',
  label: 'your tailnet',
  enabled: async () => status.state === 'connected',
  hostnameFor: async (app) => {
    const st = d().settings();
    return st.on && st.ok ? hostnameOf(app, st.cfg) : null;
  },
  identify: tailnetIdentity({ trustedPeers }),
  attach,
  detach,
  edgeState,
});

export function __setTailnetDepsForTest(p: Partial<TailnetDeps> | null): void {
  deps = p ? { ...realDeps(), ...p } : null;
  status = { state: 'off', warnings: [] };
  vault = null;
  probe = null;
  api = null;
  routeProblems.clear();
  chain = Promise.resolve();
}

export const __refreshTailnetStatusForTest = (force = true) => refreshStatus(force);
