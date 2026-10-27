/**
 * The Cloudflare publishing route (docs/webchat/workloads.md, "The Cloudflare
 * route"). Registers the `cloudflare` route kind with the gateway and keeps
 * Cloudflare in step with the published apps:
 *
 *   enable     this install's remotely-managed tunnel (found by name or
 *              created), its connector token in a 0600 file, the connector
 *              on the edge network, and a catch-all Access application on
 *              *.<domain> that denies everyone
 *   expose     the app's own Access application (its "who can open" as the
 *              policy; its audience is the only one its tokens are accepted
 *              with), then its DNS record, then its hostname in the tunnel's
 *              ingress: a hostname is never routed before Access guards it
 *   unexpose   the reverse: out of the ingress, DNS record deleted, Access
 *              application deleted; deletes Cloudflare refused are retried
 *   each sweep the same for every app, and each app's policy rewritten when
 *              the people it names changed (membership, owners, users), or
 *              hourly
 *
 * The route is on only while everything it needs is there (cloudflareStatus):
 * the setting, the gateway listening on the edge address, the API token in
 * the vault (and no OneCLI identity in `all` mode), the host rules for the
 * edge network, and a working Cloudflare API.
 */
import { log } from '../../../log.js';
import { INSTALL_SLUG } from '../../../config.js';
import { tailnetHostNames } from '../../../channels/webchat/request-guard.js';
import { verifyJwt } from '../../../channels/webchat/auth.js';
import { canAccessAgentGroup } from '../../permissions/access.js';
import { getOwners } from '../../permissions/db/user-roles.js';
import { getAllUsers } from '../../permissions/db/users.js';
import { realOnecliAdmin, type OnecliAdmin } from '../../user-credentials/onecli-admin.js';
import { gatewaySettings, type GatewaySettings } from '../gateway/config.js';
import { cloudflareIdentity } from '../gateway/identity.js';
import { registerPublishingRoute, type PublishedApp } from '../gateway/publishing.js';
import { listRoutes, type AppRoute } from '../routes.js';
import { workloadsSwitchedOn } from '../settings.js';
import type { EdgeConfig } from '../tailnet/config.js';
import { ensureEdgeNetwork, evictStrangers, probeEdge, type EdgeIsolation } from '../tailnet/edge.js';
import { realDocker, type DockerRun } from '../tailnet/sidecar.js';
import { CloudflareApi, CloudflareApiError, realCloudflareHttp, type CloudflareHttp, type IngressRule } from './api.js';
import { cloudflareSettings, domainConflict, type CloudflareConfig, type CloudflareSettings } from './config.js';
import {
  connectorArgs,
  connectorState,
  hasTokenFile,
  removeConnector,
  removeTokenFile,
  specHash,
  startConnector,
  writeTokenFile,
} from './connector.js';
import { checkVault, type VaultCheck } from './credential.js';
import { allowedEmails, appBody, bodyHash, catchAllBody, type PolicyDeps } from './policy.js';
import { loadState, updateState, type AppRecord, type CloudflareState, type PendingDelete } from './state.js';

export interface CloudflareDeps {
  docker: DockerRun;
  http: CloudflareHttp;
  admin: OnecliAdmin;
  settings: () => CloudflareSettings;
  gateway: () => GatewaySettings;
  workloadsOn: () => boolean;
  routes: () => Promise<AppRoute[]>;
  probe: (docker: DockerRun, cfg: EdgeConfig) => Promise<EdgeIsolation>;
  /** NanoClaw's own tailnet names (the app domain may not share a site with them either). */
  tailnetNames: () => Promise<string[]>;
  /** NanoClaw's own Access audience (WEBCHAT_CF_ACCESS_AUD): never an app's. */
  ownAudience: () => string;
  policy: PolicyDeps;
  verify: typeof verifyJwt;
  now: () => number;
  uid: number;
  gid: number;
}

const realDeps = (): CloudflareDeps => ({
  docker: realDocker,
  http: realCloudflareHttp,
  admin: realOnecliAdmin,
  settings: () => cloudflareSettings(),
  gateway: () => gatewaySettings(),
  workloadsOn: workloadsSwitchedOn,
  routes: () => listRoutes(),
  probe: probeEdge,
  tailnetNames: () => tailnetHostNames(),
  ownAudience: () => (process.env.WEBCHAT_CF_ACCESS_AUD || '').trim(),
  policy: {
    allUserIds: async () => (await getAllUsers()).map((u) => u.id),
    ownerIds: async () => (await getOwners()).map((r) => r.user_id),
    canAccessAgentGroup: async (u, g) => (await canAccessAgentGroup(u, g)).allowed,
  },
  verify: verifyJwt,
  now: Date.now,
  uid: process.getuid?.() ?? 1000,
  gid: process.getgid?.() ?? 1000,
});

let deps: CloudflareDeps | null = null;
const d = (): CloudflareDeps => (deps ??= realDeps());
const apiFor = (accountId: string, zoneId: string): CloudflareApi =>
  new CloudflareApi(
    d().http,
    () => accountId,
    () => zoneId,
  );

const errText = (err: unknown): string => String((err as Error).message ?? err).slice(0, 300);

// --- Status ---------------------------------------------------------------

export type CloudflareStatus =
  | { state: 'off'; warnings: string[] }
  | { state: 'connected'; warnings: string[] }
  | { state: 'missing'; missing: string; warnings: string[] };

const VAULT_EVERY_MS = 10 * 60_000;
const PROBE_EVERY_MS = 30 * 60_000;
const API_EVERY_MS = 10 * 60_000;
/** Each app's Access application is written again at least this often. */
const RESYNC_MS = 60 * 60_000;

let status: CloudflareStatus = { state: 'off', warnings: [] };
let vault: { at: number; r: VaultCheck } | null = null;
let probe: { at: number; r: string | null } | null = null;
let api: { at: number; r: string | null; tunnel: { id: string; status: string } | null } | null = null;
/** What the last setup pass (tunnel, token, catch-all) found wrong, or null. */
let setupProblem: string | null = null;
const routeProblems = new Map<string, string>();

/** For the Admin GUI's status line: `Connected`, or the one thing missing (and any warnings). */
export const cloudflareStatus = (): CloudflareStatus => status;

/** Check again now, after an owner changed something in Admin → Publishing. */
export const refreshCloudflareStatus = (): Promise<CloudflareStatus> => refreshStatus(true);

async function computeStatus(force = false): Promise<CloudflareStatus> {
  const x = d();
  const st = x.settings();
  if (!st.on) return { state: 'off', warnings: [] };
  const missing = (m: string, warnings: string[] = []): CloudflareStatus => ({
    state: 'missing',
    missing: m,
    warnings,
  });
  if (!st.ok) return missing(st.reason);
  if (!x.workloadsOn()) return missing('workloads are off on this host (NANOCLAW_WORKLOADS=1)');
  const g = x.gateway();
  if (!g.on) return missing('the app gateway is off (set NANOCLAW_WORKLOAD_GATEWAY_PORT)');
  if (!g.ok) return missing(g.reason);
  if (g.cfg.bind !== st.cfg.gateway)
    return missing(
      `the app gateway must listen on the edge address: set NANOCLAW_WORKLOAD_GATEWAY_BIND=${st.cfg.gateway}`,
    );
  const conflict = domainConflict(st.cfg.domain, await x.tailnetNames().catch(() => []));
  if (conflict) return missing(conflict);
  const own = x.ownAudience();
  if (own && Object.values(loadState().apps).some((a) => a.aud === own))
    return missing(
      'an app’s Access audience equals WEBCHAT_CF_ACCESS_AUD: NanoClaw’s own Access application must be a separate one',
    );
  const now = x.now();
  if (force || !vault || now - vault.at >= VAULT_EVERY_MS || !vault.r.ok) {
    const r = await checkVault(x.admin).catch(
      (err: unknown): VaultCheck => ({
        ok: false,
        missing: `OneCLI could not be asked: ${errText(err).slice(0, 200)}`,
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
      r = `the edge network check could not run: ${errText(err).slice(0, 200)}`;
    }
    probe = { at: now, r };
  }
  if (probe.r) return missing(probe.r, warnings);
  if (force || !api || now - api.at >= API_EVERY_MS || api.r) {
    const a = apiFor(st.cfg.accountId, st.cfg.zoneId);
    api = await a.findTunnel(st.cfg.tunnelName).then(
      (tunnel) => ({ at: now, r: null, tunnel }),
      (err: unknown) => ({ at: now, r: errText(err).slice(0, 200), tunnel: null }),
    );
  }
  if (api.r) return missing(api.r, warnings);
  if (api.tunnel && api.tunnel.status && api.tunnel.status !== 'healthy' && api.tunnel.status !== 'inactive')
    warnings.push(`the tunnel is ${api.tunnel.status}`);
  const pending = loadState().pendingDeletes.length;
  if (pending) warnings.push(`${pending} thing${pending === 1 ? '' : 's'} still to be deleted in Cloudflare`);
  return { state: 'connected', warnings };
}

function setStatus(next: CloudflareStatus): CloudflareStatus {
  const prev = status;
  status = next;
  if (status.state === 'missing' && (prev.state !== 'missing' || prev.missing !== status.missing))
    log.warn('Cloudflare route not available', { missing: status.missing });
  else if (status.state === 'connected' && prev.state !== 'connected') log.info('Cloudflare route connected');
  return status;
}

/** The status, with what the last setup pass found wrong (if anything) in place of `connected`. */
const withSetup = (s: CloudflareStatus): CloudflareStatus =>
  s.state === 'connected' && setupProblem ? { state: 'missing', missing: setupProblem, warnings: s.warnings } : s;

async function refreshStatus(force = false): Promise<CloudflareStatus> {
  return setStatus(withSetup(await computeStatus(force)));
}

// --- Cloudflare objects -----------------------------------------------------

/** One change at a time: the state file and the tunnel's ingress are shared. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const hostnameOf = (app: string, cfg: CloudflareConfig): string => `${app}.${cfg.domain}`;
const teamName = (cfg: CloudflareConfig): string => cfg.teamDomain.split('.')[0];

function queueDelete(p: PendingDelete): void {
  updateState((s) => {
    if (!s.pendingDeletes.some((q) => q.kind === p.kind && q.id === p.id)) s.pendingDeletes.push(p);
  });
}

function unqueue(p: PendingDelete): void {
  updateState((s) => {
    s.pendingDeletes = s.pendingDeletes.filter((q) => !(q.kind === p.kind && q.id === p.id));
  });
}

/** Delete one thing in Cloudflare now, or remember to. */
async function deleteOrQueue(p: PendingDelete): Promise<void> {
  const a = apiFor(p.accountId, p.zoneId);
  try {
    if (p.kind === 'dns') await a.deleteDns(p.id);
    else await a.deleteAccessApp(p.id);
    unqueue(p);
  } catch (err) {
    log.warn('Cloudflare: could not delete yet, will retry', { kind: p.kind, id: p.id, err: errText(err) });
    queueDelete(p);
  }
}

/**
 * The tunnel's ingress: each app that has its Access application and DNS
 * record, to the gateway on the edge address, and cloudflared itself checks
 * the app's Access token before forwarding. Everything else: 404.
 */
function ingressFor(st: CloudflareState, cfg: CloudflareConfig, gatewayPort: number): IngressRule[] {
  const ready = Object.values(st.apps)
    .filter((a) => a.accessAppId && a.aud && a.dnsRecordId && a.hostname === hostnameOf(a.app, cfg))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
  return [
    ...ready.map((a) => ({
      hostname: a.hostname,
      service: `http://${cfg.gateway}:${gatewayPort}`,
      originRequest: { access: { required: true, teamName: teamName(cfg), audTag: [a.aud as string] } },
    })),
    { service: 'http_status:404' },
  ];
}

/** Set the tunnel's ingress to what the state says, when it changed. */
async function applyIngress(cfg: CloudflareConfig, gatewayPort: number, force = false): Promise<void> {
  const st = loadState();
  if (!st.tunnelId) return;
  const ingress = ingressFor(st, cfg, gatewayPort);
  const h = specHash([JSON.stringify(ingress)]);
  if (!force && st.ingressHash === h) return;
  await apiFor(cfg.accountId, cfg.zoneId).putTunnelConfig(st.tunnelId, ingress);
  updateState((s) => {
    s.ingressHash = h;
    s.ingressHosts = ingress.flatMap((r) => (r.hostname ? [r.hostname] : []));
  });
}

/**
 * The tunnel, its token on disk, and the catch-all. A changed account starts
 * over (what was made in the old one is queued for deletion); a new tunnel
 * gets a new token and its apps new DNS records.
 */
async function ensureSetup(cfg: CloudflareConfig): Promise<string> {
  const a = apiFor(cfg.accountId, cfg.zoneId);
  let st = loadState();
  if ((st.accountId && st.accountId !== cfg.accountId) || (st.zoneId && st.zoneId !== cfg.zoneId)) {
    const oldAcct = st.accountId ?? cfg.accountId;
    const oldZone = st.zoneId ?? cfg.zoneId;
    for (const rec of Object.values(st.apps)) {
      if (rec.dnsRecordId) queueDelete({ kind: 'dns', id: rec.dnsRecordId, accountId: oldAcct, zoneId: oldZone });
      if (rec.accessAppId && oldAcct !== cfg.accountId)
        queueDelete({ kind: 'access', id: rec.accessAppId, accountId: oldAcct, zoneId: oldZone });
    }
    st = updateState((s) => {
      if (s.accountId !== cfg.accountId) {
        if (s.catchAllAppId)
          s.pendingDeletes.push({ kind: 'access', id: s.catchAllAppId, accountId: oldAcct, zoneId: oldZone });
        s.tunnelId = null;
        s.catchAllAppId = null;
        s.catchAllDomain = null;
        s.apps = {};
      } else {
        for (const r of Object.values(s.apps)) r.dnsRecordId = null;
      }
      s.ingressHash = null;
      s.ingressHosts = [];
    });
    removeTokenFile();
  }
  updateState((s) => {
    s.accountId = cfg.accountId;
    s.zoneId = cfg.zoneId;
  });
  // The tunnel: by name, else made now.
  const found = api?.tunnel ?? (await a.findTunnel(cfg.tunnelName));
  const tunnelId = found?.id ?? (await a.createTunnel(cfg.tunnelName));
  if (!found) log.info('Cloudflare: tunnel created', { tunnel: cfg.tunnelName });
  if (api) api.tunnel = { id: tunnelId, status: found?.status ?? 'inactive' };
  if (st.tunnelId !== tunnelId) {
    // Another tunnel: the apps' DNS records pointed at the old one.
    for (const rec of Object.values(st.apps))
      if (rec.dnsRecordId)
        queueDelete({ kind: 'dns', id: rec.dnsRecordId, accountId: cfg.accountId, zoneId: cfg.zoneId });
    updateState((s) => {
      s.tunnelId = tunnelId;
      for (const r of Object.values(s.apps)) r.dnsRecordId = null;
      s.ingressHash = null;
      s.ingressHosts = [];
    });
    removeTokenFile();
  }
  if (!hasTokenFile()) writeTokenFile(await a.tunnelToken(tunnelId));
  await ensureCatchAll(cfg, a);
  return tunnelId;
}

const ourName = (name: string): boolean => name.startsWith(`NanoClaw ${INSTALL_SLUG}: `);

/** The catch-all deny application on *.<domain>; the one for a previous domain is deleted. */
async function ensureCatchAll(cfg: CloudflareConfig, a: CloudflareApi): Promise<void> {
  const st = loadState();
  const body = catchAllBody(INSTALL_SLUG, cfg.domain);
  if (st.catchAllAppId && st.catchAllDomain === cfg.domain) return;
  if (st.catchAllAppId)
    await deleteOrQueue({ kind: 'access', id: st.catchAllAppId, accountId: cfg.accountId, zoneId: cfg.zoneId });
  const existing = await a.findAccessApps(body.domain);
  const mine = existing.find((x) => ourName(x.name));
  if (!mine && existing.length)
    throw new Error(
      `an Access application on ${body.domain} already exists that NanoClaw did not make: remove it (NanoClaw makes its own, which denies everyone)`,
    );
  const app = mine ? await a.updateAccessApp(mine.id, body) : await a.createAccessApp(body);
  updateState((s) => {
    s.catchAllAppId = app.id;
    s.catchAllDomain = cfg.domain;
  });
  log.info('Cloudflare: catch-all Access application in place', { domain: body.domain });
}

function forgetApp(routeId: string, patch?: Partial<AppRecord>): void {
  updateState((s) => {
    if (!s.apps[routeId]) return;
    if (patch) s.apps[routeId] = { ...s.apps[routeId], ...patch };
    else delete s.apps[routeId];
  });
}

/** Out of the ingress, DNS record deleted, Access application deleted (each retried when refused). */
async function removeApp(rec: AppRecord, gatewayPort: number | null): Promise<void> {
  const st = loadState();
  const acct = st.accountId;
  const zone = st.zoneId;
  forgetApp(rec.routeId);
  routeProblems.delete(rec.routeId);
  const s = d().settings();
  if (s.on && s.ok && gatewayPort)
    await applyIngress(s.cfg, gatewayPort).catch((err: unknown) =>
      log.warn('Cloudflare: could not take a hostname out of the tunnel yet', { app: rec.app, err: errText(err) }),
    );
  if (acct && zone) {
    if (rec.dnsRecordId) await deleteOrQueue({ kind: 'dns', id: rec.dnsRecordId, accountId: acct, zoneId: zone });
    if (rec.accessAppId) await deleteOrQueue({ kind: 'access', id: rec.accessAppId, accountId: acct, zoneId: zone });
  }
  log.info('Cloudflare: app unpublished', { app: rec.app, hostname: rec.hostname });
}

/** The app's Access application (in step with who may open it) and DNS record. Throws with what is wrong. */
async function ensureApp(route: AppRoute, cfg: CloudflareConfig, tunnelId: string, gatewayPort: number): Promise<void> {
  const x = d();
  const a = apiFor(cfg.accountId, cfg.zoneId);
  const hostname = hostnameOf(route.app, cfg);
  let rec: AppRecord | undefined = loadState().apps[route.id];
  if (rec && (rec.app !== route.app || rec.hostname !== hostname)) {
    await removeApp(rec, gatewayPort);
    rec = undefined;
  }
  if (!rec) {
    rec = {
      routeId: route.id,
      app: route.app,
      hostname,
      accessAppId: null,
      aud: null,
      dnsRecordId: null,
      policyHash: null,
      syncedAt: 0,
    };
    const fresh = rec;
    updateState((s) => {
      s.apps[route.id] = fresh;
    });
  }
  const body = appBody(INSTALL_SLUG, route.app, hostname, await allowedEmails(route, x.policy));
  const h = bodyHash(body);
  const own = x.ownAudience();
  if (!rec.accessAppId) {
    const existing = await a.findAccessApps(hostname);
    const mine = existing.find((e) => ourName(e.name));
    if (!mine && existing.length)
      throw new Error(
        `an Access application for ${hostname} already exists that NanoClaw did not make: remove it or pick another app name`,
      );
    const made = mine ? await a.updateAccessApp(mine.id, body) : await a.createAccessApp(body);
    if (own && made.aud === own) {
      await a.deleteAccessApp(made.id).catch(() => undefined);
      throw new Error('Cloudflare gave this app NanoClaw’s own Access audience: refused');
    }
    rec = { ...rec, accessAppId: made.id, aud: made.aud, policyHash: h, syncedAt: x.now() };
    forgetApp(route.id, { accessAppId: made.id, aud: made.aud, policyHash: h, syncedAt: rec.syncedAt });
  } else if (rec.policyHash !== h || x.now() - rec.syncedAt >= RESYNC_MS) {
    let made;
    try {
      made = await a.updateAccessApp(rec.accessAppId, body);
    } catch (err) {
      if (!(err instanceof CloudflareApiError) || err.status !== 404) throw err;
      // Deleted in the dashboard: out of the ingress until it is made again.
      forgetApp(route.id, { accessAppId: null, aud: null, policyHash: null });
      await applyIngress(cfg, gatewayPort);
      throw new Error(`the Access application for ${hostname} was deleted in Cloudflare: making it again`, {
        cause: err,
      });
    }
    if (own && made.aud === own) throw new Error('this app’s Access audience equals NanoClaw’s own: refused');
    rec = { ...rec, aud: made.aud, policyHash: h, syncedAt: x.now() };
    forgetApp(route.id, { aud: made.aud, policyHash: h, syncedAt: rec.syncedAt });
  }
  if (!rec.dnsRecordId) {
    const target = `${tunnelId}.cfargotunnel.com`;
    const existing = await a.findDns(hostname);
    const mine = existing.find((r) => r.type === 'CNAME' && r.content.toLowerCase() === target);
    if (!mine && existing.length)
      throw new Error(`${hostname} already has a DNS record NanoClaw did not make: remove it or pick another app name`);
    const id = mine?.id ?? (await a.createCname(hostname, target, `NanoClaw ${INSTALL_SLUG}: ${route.app}`));
    forgetApp(route.id, { dnsRecordId: id });
  }
}

function noteProblem(route: AppRoute, err: unknown): void {
  const msg = errText(err);
  if (routeProblems.get(route.id) !== msg) log.warn('Cloudflare: app not published yet', { app: route.app, err: msg });
  routeProblems.set(route.id, msg);
}

/** The connector runs with the current arguments and token. */
async function ensureConnector(cfg: CloudflareConfig, tunnelId: string): Promise<void> {
  const x = d();
  const args = connectorArgs({ cfg, tunnelId, uid: x.uid, gid: x.gid });
  const cs = await connectorState(x.docker);
  if (cs?.running && cs.spec === specHash(args)) return;
  await startConnector(x.docker, args);
  log.info('Cloudflare: connector started', { tunnel: cfg.tunnelName });
}

/** Every Cloudflare app published, every record without an app removed, deletes retried. */
async function reconcile(cfg: CloudflareConfig, gatewayPort: number, connected: boolean): Promise<void> {
  const x = d();
  const wanted = (await x.routes()).filter((r) => r.kind === 'cloudflare');
  const ids = new Set(wanted.map((r) => r.id));
  for (const rec of Object.values(loadState().apps)) if (!ids.has(rec.routeId)) await removeApp(rec, gatewayPort);
  if (!connected) return;
  let tunnelId: string;
  try {
    tunnelId = await ensureSetup(cfg);
    setupProblem = null;
  } catch (err) {
    setupProblem = errText(err);
    return;
  }
  await ensureConnector(cfg, tunnelId);
  for (const r of wanted) {
    try {
      await ensureApp(r, cfg, tunnelId, gatewayPort);
      routeProblems.delete(r.id);
    } catch (err) {
      noteProblem(r, err);
    }
  }
  await applyIngress(cfg, gatewayPort).catch((err: unknown) =>
    log.warn('Cloudflare: could not set the tunnel’s hostnames', { err: errText(err) }),
  );
  for (const p of loadState().pendingDeletes) await deleteOrQueue(p);
}

/** Whether the switched-off state was settled since the route went off (once, not every minute). */
let offSettled = false;

/** Switched off: the connector stops, its token is removed, and every app's records go. */
async function teardown(): Promise<void> {
  await removeConnector(d().docker);
  removeTokenFile();
  for (const rec of Object.values(loadState().apps)) await removeApp(rec, null);
}

/**
 * One pass, before the gateway's (the gateway listens on the edge network's
 * address, so the network must exist first).
 */
export async function tickCloudflare(switchedOn = true): Promise<void> {
  const x = d();
  const st = x.settings();
  if (!switchedOn || !st.on) {
    status = { state: 'off', warnings: [] };
    setupProblem = null;
    if (!offSettled || Object.keys(loadState().apps).length || hasTokenFile()) {
      await serial(teardown);
      offSettled = true;
    }
    return;
  }
  offSettled = false;
  if (!st.ok) {
    await refreshStatus();
    return;
  }
  await serial(async () => {
    await ensureEdgeNetwork(x.docker, st.cfg);
    await evictStrangers(x.docker);
    const s = await computeStatus();
    const g = x.gateway();
    await reconcile(st.cfg, g.on && g.ok ? g.cfg.port : 0, s.state === 'connected');
    setStatus(withSetup(s));
  });
}

// --- The route kind -------------------------------------------------------

async function attach(route: AppRoute): Promise<void> {
  const st = d().settings();
  const g = d().gateway();
  const tunnelId = loadState().tunnelId;
  if (!st.on || !st.ok || !g.on || !g.ok || status.state !== 'connected' || !tunnelId) return;
  await serial(async () => {
    await ensureApp(route, st.cfg, tunnelId, g.cfg.port);
    await applyIngress(st.cfg, g.cfg.port);
  })
    .then(() => routeProblems.delete(route.id))
    .catch((err: unknown) => noteProblem(route, err));
}

async function detach(route: AppRoute): Promise<void> {
  const g = d().gateway();
  await serial(async () => {
    const rec = loadState().apps[route.id];
    if (rec) await removeApp(rec, g.on && g.ok ? g.cfg.port : null);
  });
}

/** Only the connector may speak for an app on this route. */
async function trustedPeers(): Promise<string[]> {
  const st = d().settings();
  return st.on && st.ok ? [st.cfg.connector] : [];
}

let warnedOwnAud = false;
/** The app's own Access audience; never NanoClaw's. */
async function audienceFor(app: PublishedApp): Promise<string | null> {
  const rec = loadState().apps[app.id];
  if (!rec || rec.app !== app.app || !rec.aud) return null;
  const own = d().ownAudience();
  if (own && rec.aud === own) {
    if (!warnedOwnAud)
      log.error('Cloudflare: an app has NanoClaw’s own Access audience; refusing its tokens', { app: app.app });
    warnedOwnAud = true;
    return null;
  }
  return rec.aud;
}

async function edgeState(route: AppRoute): Promise<{ ready: boolean; problem?: string }> {
  const st = loadState();
  const rec = st.apps[route.id];
  const problem = routeProblems.get(route.id);
  const ready = Boolean(rec?.accessAppId && rec.dnsRecordId && st.ingressHosts.includes(rec.hostname)) && !problem;
  return { ready, ...(problem ? { problem } : {}) };
}

registerPublishingRoute({
  kind: 'cloudflare',
  label: 'Cloudflare',
  enabled: async () => status.state === 'connected',
  hostnameFor: async (app) => {
    const st = d().settings();
    return st.on && st.ok ? hostnameOf(app, st.cfg) : null;
  },
  identify: cloudflareIdentity({
    trustedPeers,
    teamDomain: () => {
      const st = d().settings();
      return st.on && st.ok ? st.cfg.teamDomain : '';
    },
    audienceFor,
    verify: (token, cfg) => d().verify(token, cfg),
  }),
  attach,
  detach,
  edgeState,
});

export function __setCloudflareDepsForTest(p: Partial<CloudflareDeps> | null): void {
  deps = p ? { ...realDeps(), ...p } : null;
  status = { state: 'off', warnings: [] };
  vault = null;
  probe = null;
  api = null;
  setupProblem = null;
  offSettled = false;
  warnedOwnAud = false;
  routeProblems.clear();
  chain = Promise.resolve();
}

export const __refreshCloudflareStatusForTest = (force = true) => refreshStatus(force);
