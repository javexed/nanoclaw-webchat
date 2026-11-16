/**
 * Agent → Apps in webchat: what a person sees of an agent's apps, and what
 * happens when they change one.
 *
 * "An agent can only ask; a person can always narrow." A person's change is
 * classified against the app as it is now:
 *
 *   narrow   unpublish (route Off), a narrower "who can open", fewer named
 *            people: applied at once, no card
 *   widen    publish (Off → a route), a route change, a wider "who can open",
 *            anyone named who was not before: an approval card to the owners
 *            and global admins, whoever is asking (an owner included: the
 *            card is the confirmation and the record, the same for everyone)
 *
 * A widening card pins what it showed (app, route, rule, people, service and
 * port); on approve it is planned again, refused if anything moved, and the
 * person who asked must still administer the agent. The asker becomes the
 * app's "only me".
 *
 * The same rule holds for a build source (Docker Hub, npm, …): turning one on
 * widens what the agent's builds may reach (a registry a build pulls from is
 * one it can send to), so it is a card; turning it off applies at once. Extend and
 * Redeploy keep what was approved, so a person's click applies directly.
 */
import { quoteForCard } from '../../card-text.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getPendingApprovalsByAction } from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerSessionlessApprovalHandler, requestSessionlessApproval } from '../approvals/sessionless.js';
import { getUser } from '../permissions/db/users.js';
import { diskLevel, diskUsed, gb, type DiskLevel } from './disk.js';
import { syncGateway } from './gateway/index.js';
import { enabledRoutes, isRouteKind, publishingRoute, ROUTE_KIND_WORDS, type RouteKind } from './gateway/publishing.js';
import { declaredPort, exposeApp, parseEmails, planExpose, routeView, unexposeApp, widensAccess } from './publish.js';
import { findRouteByApp, isWho, listRoutes, updateRoute, type AppRoute, type Who } from './routes.js';
import { notifyWorkloadAgent } from './notify.js';
import { confinedBuildsOn, workloadsSwitchedOn } from './settings.js';
import {
  buildRegistries,
  findWorkload,
  listWorkloads,
  quotaFor,
  setBuildRegistries,
  workloadsReady,
  type Workload,
} from './store.js';

/** The session-less approval action a person's widening asks under. */
export const PUBLISH_ACTION = 'workloads_publish';
/** …and the one a build source (Agent → Apps → Build sources) asks under. */
export const BUILD_REGISTRIES_ACTION = 'workloads_build_registries';

/** Docker Hub's registry, token service and the CDNs its layers come from. */
export const DOCKER_HUB: readonly string[] = [
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  'production.cloudfront.docker.com',
];
export const hasDockerHub = (hosts: readonly string[]): boolean => DOCKER_HUB.every((h) => hosts.includes(h));

/** A package source a build may download from, turned on by its own card. */
export interface BuildSource {
  id: string;
  label: string;
  hosts: readonly string[];
}
export const BUILD_SOURCES: readonly BuildSource[] = [
  { id: 'dockerhub', label: 'Docker Hub', hosts: DOCKER_HUB },
  { id: 'npm', label: 'npm', hosts: ['registry.npmjs.org'] },
  {
    id: 'os',
    label: 'OS packages',
    hosts: [
      'dl-cdn.alpinelinux.org',
      'deb.debian.org',
      'security.debian.org',
      'archive.ubuntu.com',
      'security.ubuntu.com',
      'ports.ubuntu.com',
    ],
  },
  { id: 'pypi', label: 'PyPI', hosts: ['pypi.org', 'files.pythonhosted.org'] },
  { id: 'ghcr', label: 'GitHub images', hosts: ['ghcr.io', 'pkg-containers.githubusercontent.com'] },
];
/** A card raised before sources existed names no source: it was Docker Hub. */
export const buildSource = (id: unknown): BuildSource | undefined =>
  BUILD_SOURCES.find((s) => s.id === (id === undefined ? 'dockerhub' : id));
const hasSource = (hosts: readonly string[], s: BuildSource): boolean => s.hosts.every((h) => hosts.includes(h));

export type RouteChoice = 'off' | RouteKind;
export const isRouteChoice = (v: unknown): v is RouteChoice => v === 'off' || isRouteKind(v);

export interface AppSetting {
  route: RouteChoice;
  who: Who;
  emails: string[];
}

export type Change = 'none' | 'narrow' | 'widen';

/** Narrow, widen, or nothing, from `prev` to `next`. Pure; ui/src/features/apps-state.ts mirrors it. */
export function classifyChange(prev: AppSetting, next: AppSetting): Change {
  if (next.route === 'off') return prev.route === 'off' ? 'none' : 'narrow';
  if (prev.route === 'off' || prev.route !== next.route) return 'widen';
  const same =
    prev.who === next.who &&
    prev.emails.length === next.emails.length &&
    prev.emails.every((e) => next.emails.includes(e));
  if (same) return 'none';
  return widensAccess(prev, next) ? 'widen' : 'narrow';
}

/**
 * What a workload that has no app yet can be published as: each service with
 * an address that declares an `expose:` port (its first). With none, NanoClaw
 * cannot tell what to serve and the agent publishes it with `ncl workloads expose`.
 */
export function exposable(w: Pick<Workload, 'stack' | 'addresses'>): Array<{ service: string; port: number }> {
  const found: Array<{ service: string; port: number }> = [];
  for (const [service, def] of Object.entries(w.stack.compose.services)) {
    if (!w.addresses[service]) continue;
    const port = declaredPort(def);
    if (port) found.push({ service, port });
  }
  return found.sort((a, b) => a.service.localeCompare(b.service));
}

/** The target for a publish: the one exposable service, or the one the person picked. */
export function pickTarget(
  w: Pick<Workload, 'stack' | 'addresses'>,
  service?: unknown,
): { service: string; port: number } | null {
  const all = exposable(w);
  if (typeof service === 'string' && service) return all.find((t) => t.service === service) ?? null;
  return all.length === 1 ? all[0] : null;
}

// --- Pending cards ---------------------------------------------------------

const AGENT_CARD_COMMANDS = new Set([
  'workloads-expose',
  'workloads-up',
  'workloads-restore',
  'workloads-delete',
  'workloads-extend',
]);

export interface Pending {
  /** App names with a card waiting. */
  apps: Set<string>;
  /** Workload names with a card waiting. */
  workloads: Set<string>;
  /** Build sources with a card waiting. */
  buildSources: Set<string>;
}

const parse = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Cards waiting for this agent's workloads and apps: the agent's own (`ncl workloads …`) and people's. */
export async function pendingFor(agentGroupId: string): Promise<Pending> {
  const out: Pending = { apps: new Set(), workloads: new Set(), buildSources: new Set() };
  for (const a of await getPendingApprovalsByAction(BUILD_REGISTRIES_ACTION)) {
    if (a.status !== 'pending') continue;
    const p = parse(a.payload);
    const source = buildSource(p.source);
    if (p.agentGroupId === agentGroupId && source) out.buildSources.add(source.id);
  }
  for (const a of await getPendingApprovalsByAction(PUBLISH_ACTION)) {
    if (a.status !== 'pending') continue;
    const p = parse(a.payload);
    if (p.agentGroupId !== agentGroupId) continue;
    if (typeof p.app === 'string') out.apps.add(p.app);
    if (typeof p.workload === 'string') out.workloads.add(p.workload);
  }
  for (const a of await getPendingApprovalsByAction('cli_command')) {
    if (a.status !== 'pending' && a.status !== 'awaiting_reason') continue;
    const p = parse(a.payload);
    const frame = (p.frame ?? {}) as { command?: unknown; args?: Record<string, unknown> };
    const caller = (p.callerContext ?? {}) as { agentGroupId?: unknown };
    if (typeof frame.command !== 'string' || !AGENT_CARD_COMMANDS.has(frame.command)) continue;
    if ((caller.agentGroupId ?? a.agent_group_id) !== agentGroupId) continue;
    const name = typeof frame.args?.name === 'string' ? frame.args.name : '';
    if (name) out.workloads.add(name);
    // An expose, or a deploy that publishes (`up --publish`), waits on the app too.
    if (frame.command === 'workloads-expose' || (frame.command === 'workloads-up' && frame.args?.publish))
      out.apps.add(String(frame.args?.app || name).toLowerCase());
  }
  return out;
}

// --- The list --------------------------------------------------------------

export type AppState = 'running' | 'stopped' | 'needs-approval';

export interface AppRow {
  /** The app's name; null for a workload that is not published. */
  app: string | null;
  workload: string;
  state: AppState;
  route: RouteChoice;
  who: Who;
  emails: string[];
  /** Where people open it, when it is live. */
  url: string | null;
  /** An unpublished workload NanoClaw can publish from here (it knows which service and port). */
  canPublish: boolean;
  /** For an unpublished workload: the services it can be published as (a choice when more than one). */
  services: string[];
  /** The workload exists (false: a first deploy still waiting for its card). */
  deployed: boolean;
  /** Its containers are running. */
  running: boolean;
  /** When it is stopped (ms), unless extended; null: it does not expire. */
  expiresAt: number | null;
  /** Published: renewed near its expiry while people open it (reconcile.ts). */
  renewsWhileUsed: boolean;
}

export interface AppsView {
  /** Workloads are switched on for this host (whether or not the preflight passed). */
  available: boolean;
  /** The routes switched on and usable now. */
  routes: RouteKind[];
  disk: { usedGb: number; quotaGb: number; level: DiskLevel } | null;
  /** Confined builds on this host, and which package sources this agent's builds may download from. */
  builds: { on: boolean; sources: BuildSourceRow[] };
  apps: AppRow[];
}

export interface BuildSourceRow {
  id: string;
  label: string;
  on: boolean;
  /** A card to turn it on is waiting. */
  pending: boolean;
}

const sourceRows = (registries: readonly string[], pending: Set<string>): BuildSourceRow[] =>
  BUILD_SOURCES.map((s) => ({ id: s.id, label: s.label, on: hasSource(registries, s), pending: pending.has(s.id) }));

export async function appsOf(agentGroupId: string): Promise<AppsView> {
  const routes = (await enabledRoutes()).map((r) => r.kind);
  const available = workloadsSwitchedOn();
  const builds = { on: confinedBuildsOn(), sources: sourceRows([], new Set()) };
  if (!(await workloadsReady())) return { available, routes, disk: null, builds, apps: [] };
  const [workloads, published, pending, quota, registries] = await Promise.all([
    listWorkloads({ agentGroupId }),
    listRoutes({ agentGroupId }),
    pendingFor(agentGroupId),
    quotaFor(agentGroupId),
    buildRegistries(agentGroupId),
  ]);
  builds.sources = sourceRows(registries, pending.buildSources);
  const apps: AppRow[] = [];
  const shown = new Set<string>();
  for (const w of workloads) {
    if (w.state === 'deleted') continue;
    shown.add(w.name);
    const base = w.state === 'running' ? 'running' : 'stopped';
    const mine = published.filter((r) => r.workloadId === w.id);
    for (const r of mine) {
      const v = await routeView(r);
      apps.push({
        app: r.app,
        workload: w.name,
        state: pending.apps.has(r.app) || pending.workloads.has(w.name) ? 'needs-approval' : base,
        route: r.kind,
        who: r.who,
        emails: r.who === 'specific' ? r.emails : [],
        url: typeof v.url === 'string' ? v.url : null,
        canPublish: true,
        services: [r.service],
        deployed: true,
        running: w.state === 'running',
        expiresAt: w.expiresAt,
        renewsWhileUsed: w.expiresAt !== null,
      });
    }
    if (!mine.length)
      apps.push({
        app: null,
        workload: w.name,
        state: pending.workloads.has(w.name) || pending.apps.has(w.name) ? 'needs-approval' : base,
        route: 'off',
        who: 'only-me',
        emails: [],
        url: null,
        canPublish: exposable(w).length > 0,
        services: exposable(w).map((t) => t.service),
        deployed: true,
        running: w.state === 'running',
        expiresAt: w.expiresAt,
        renewsWhileUsed: false,
      });
  }
  // A first deploy waiting for its card has no workload row yet.
  for (const name of [...pending.workloads].sort())
    if (!shown.has(name))
      apps.push({
        app: null,
        workload: name,
        state: 'needs-approval',
        route: 'off',
        who: 'only-me',
        emails: [],
        url: null,
        canPublish: false,
        services: [],
        deployed: false,
        running: false,
        expiresAt: null,
        renewsWhileUsed: false,
      });
  const used = diskUsed(agentGroupId);
  return {
    available,
    routes,
    disk: used ? { usedGb: gb(used.bytes), quotaGb: quota.diskGb, level: diskLevel(used.bytes, quota.diskGb) } : null,
    builds,
    apps,
  };
}

// --- A person's change -----------------------------------------------------

export interface ChangeInput {
  workload: unknown;
  app?: unknown;
  route: unknown;
  who?: unknown;
  emails?: unknown;
  /** Publishing an unpublished workload with several exposable services: which one. */
  service?: unknown;
}

export type ChangeResult = { change: Change; applied: boolean; pending: boolean };

/** A refusal the person can act on: shown as is. */
export class ChangeRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function readNext(i: ChangeInput, prev: AppSetting): AppSetting {
  if (!isRouteChoice(i.route)) throw new ChangeRefused(`route must be off, ${ROUTE_KIND_WORDS}`);
  if (i.route === 'off') return { route: 'off', who: prev.who, emails: prev.emails };
  const who = i.who === undefined ? prev.who : i.who;
  if (!isWho(who)) throw new ChangeRefused('who must be only-me, specific, agent-members or signed-in');
  if (who !== 'specific') return { route: i.route, who, emails: [] };
  if (i.route !== 'cloudflare') throw new ChangeRefused('Specific people is for Cloudflare only');
  let emails: string[];
  try {
    emails = parseEmails(Array.isArray(i.emails) ? i.emails.map(String).join(',') : String(i.emails ?? ''));
  } catch (err) {
    throw new ChangeRefused((err as Error).message.replace(/^--emails/, 'The list'));
  }
  if (!emails.length) throw new ChangeRefused('Name at least one person');
  return { route: i.route, who, emails };
}

async function displayName(userId: string): Promise<string> {
  return (await getUser(userId).catch(() => undefined))?.display_name || userId.replace(/^[a-z]+:/, '');
}

/**
 * Apply a narrowing at once, or raise a card for a widening. `userId` is the
 * person acting, already checked to administer the agent.
 */
export async function changeApp(agentGroupId: string, userId: string, i: ChangeInput): Promise<ChangeResult> {
  const name = typeof i.workload === 'string' ? i.workload.trim() : '';
  const w = name ? await findWorkload(agentGroupId, name) : null;
  if (!w || w.state === 'deleted') throw new ChangeRefused('No such app', 404);
  let existing: AppRoute | null = null;
  if (typeof i.app === 'string' && i.app) {
    existing = await findRouteByApp(i.app.trim().toLowerCase());
    if (!existing || existing.agentGroupId !== agentGroupId || existing.workloadId !== w.id)
      throw new ChangeRefused('No such app', 404);
  }
  const prev: AppSetting = existing
    ? { route: existing.kind, who: existing.who, emails: existing.emails }
    : { route: 'off', who: 'only-me', emails: [] };
  const next = readNext(i, prev);
  const change = classifyChange(prev, next);
  if (change === 'none') return { change, applied: false, pending: false };

  if (change === 'narrow') {
    if (!existing) return { change: 'none', applied: false, pending: false };
    if (next.route === 'off') {
      await unexposeApp(agentGroupId, existing.app);
    } else {
      // "Only me" keeps whoever it already means: making it the person acting
      // could let in someone the narrower rule left out.
      const r = await updateRoute(existing.id, { who: next.who, emails: next.emails });
      await syncGateway();
      await publishingRoute(r.kind)
        ?.attach?.(r)
        .catch((err: unknown) => log.warn('Apps: route update failed', { app: r.app, err: String(err).slice(0, 200) }));
    }
    log.info('Apps: narrowed by a person', { agentGroupId, app: existing.app, by: userId, to: next });
    return { change, applied: true, pending: false };
  }

  // Widening: a card, whoever asks.
  const target = existing ? { service: existing.service, port: existing.port } : pickTarget(w, i.service);
  if (!target)
    throw new ChangeRefused(
      exposable(w).length > 1 ? 'Pick a service' : 'No service declares a port to publish: ask the agent to publish it',
    );
  const app = existing?.app ?? w.name;
  const pending = await pendingFor(agentGroupId);
  if (pending.apps.has(app)) throw new ChangeRefused('Already waiting for approval', 409);
  let plan;
  try {
    plan = await planExpose(agentGroupId, {
      name: w.name,
      service: target.service,
      port: target.port,
      app,
      route: next.route,
      who: next.who,
      ...(next.who === 'specific' ? { emails: next.emails.join(',') } : {}),
    });
  } catch (err) {
    throw new ChangeRefused(String((err as Error).message ?? err));
  }
  const whom =
    next.who === 'specific'
      ? `${next.emails.length} named ${next.emails.length === 1 ? 'person' : 'people'}`
      : WHO_CARD[next.who];
  const asker = await displayName(userId);
  const question = [
    `${quoteForCard(asker)} wants to publish ${quoteForCard(plan.app)} on ${plan.route.label} for ${whom}.`,
    '',
    `Address: https://${plan.hostname}/`,
    `Serves: ${quoteForCard(w.name)} service ${quoteForCard(target.service)}, port ${target.port}`,
    ...(existing
      ? [
          `Was: ${existing.who === 'specific' ? `${existing.emails.length} named` : WHO_CARD[existing.who]}${existing.kind !== next.route ? `, on ${existing.kind}` : ''}`,
        ]
      : []),
    ...(next.who === 'specific' ? [`People: ${next.emails.map((e) => quoteForCard(e)).join(', ')}`] : []),
  ].join('\n');
  const id = await requestSessionlessApproval({
    action: PUBLISH_ACTION,
    payload: {
      agentGroupId,
      workload: w.name,
      app: plan.app,
      service: target.service,
      port: target.port,
      route: next.route,
      who: next.who,
      emails: next.emails,
      hostname: plan.hostname,
      requestedBy: userId,
    },
    title: `Publish ${plan.app}`,
    question,
  });
  if (!id) throw new ChangeRefused('No owner or admin could be asked right now', 503);
  log.info('Apps: widening sent for approval', { agentGroupId, app: plan.app, by: userId, approvalId: id });
  return { change, applied: false, pending: true };
}

const WHO_CARD: Record<Who, string> = {
  'only-me': 'only them',
  specific: 'the people named',
  'agent-members': 'the agent’s members',
  'signed-in': 'anyone signed in to NanoClaw',
};

// --- The card's answer -----------------------------------------------------

export interface PublishDeps {
  /** May this person still administer the agent? */
  isAdmin: (userId: string, agentGroupId: string) => Promise<boolean>;
}

let publishDeps: PublishDeps | null = null;

/** Wired by the webchat server, which owns the admin check. */
export function setPublishDeps(d: PublishDeps): void {
  publishDeps = d;
}

/** Apply an approved widening, as pinned on its card. Throws when anything moved. */
export async function applyApprovedPublish(payload: Record<string, unknown>): Promise<AppRoute> {
  const agentGroupId = String(payload.agentGroupId ?? '');
  const requestedBy = String(payload.requestedBy ?? '');
  const route = payload.route;
  const who = payload.who;
  const emails = Array.isArray(payload.emails) ? payload.emails.map(String) : [];
  if (!agentGroupId || !requestedBy || !isRouteKind(route) || !isWho(who)) throw new Error('malformed card');
  if (!publishDeps || !(await publishDeps.isAdmin(requestedBy, agentGroupId)))
    throw new Error('the person who asked no longer administers this agent');
  const input = {
    name: String(payload.workload ?? ''),
    service: String(payload.service ?? ''),
    port: Number(payload.port),
    app: String(payload.app ?? ''),
    route,
    who,
    ...(who === 'specific' ? { emails: emails.join(',') } : {}),
  };
  const plan = await planExpose(agentGroupId, input);
  const sameEmails = plan.emails.length === emails.length && plan.emails.every((e) => emails.includes(e));
  if (plan.app !== input.app || plan.route.kind !== route || plan.who !== who || !sameEmails)
    throw new Error('the app changed since the card was sent');
  if (payload.hostname && plan.hostname !== payload.hostname) throw new Error('the app’s address changed');
  return exposeApp(agentGroupId, input, { userId: requestedBy, createdBy: `human:${requestedBy}` });
}

registerSessionlessApprovalHandler(PUBLISH_ACTION, async ({ payload, outcome, userId }) => {
  if (outcome !== 'approve') return;
  try {
    const r = await applyApprovedPublish(payload);
    log.info('Apps: widening approved and applied', { app: r.app, approvedBy: userId });
  } catch (err) {
    log.warn('Apps: approved widening not applied', { app: payload.app, err: String(err).slice(0, 300) });
  }
});

// --- Build sources ------------------------------------------------------------

/**
 * A build source (Agent → Apps → Build sources): on raises a card (it widens
 * what the agent's builds reach), off removes that source's hosts at once.
 * Hosts set another way (`ncl workloads build-registries`) are left alone
 * unless they are the source's own.
 */
export async function setBuildSource(
  agentGroupId: string,
  userId: string,
  sourceId: unknown,
  on: unknown,
): Promise<ChangeResult> {
  const source = buildSource(sourceId);
  if (!source) throw new ChangeRefused('Unknown build source');
  if (typeof on !== 'boolean') throw new ChangeRefused('on must be true or false');
  const current = await buildRegistries(agentGroupId);
  if (!on) {
    if (!source.hosts.some((h) => current.includes(h))) return { change: 'none', applied: false, pending: false };
    await setBuildRegistries(
      agentGroupId,
      current.filter((h) => !source.hosts.includes(h)),
    );
    log.info('Apps: build source removed by a person', { agentGroupId, source: source.id, by: userId });
    return { change: 'narrow', applied: true, pending: false };
  }
  if (hasSource(current, source)) return { change: 'none', applied: false, pending: false };
  if (!confinedBuildsOn()) throw new ChangeRefused('Builds are off on this host');
  if ((await pendingFor(agentGroupId)).buildSources.has(source.id))
    throw new ChangeRefused('Already waiting for approval', 409);
  const agent = (await getAgentGroup(agentGroupId))?.name || agentGroupId;
  const asker = await displayName(userId);
  const id = await requestSessionlessApproval({
    action: BUILD_REGISTRIES_ACTION,
    payload: { agentGroupId, source: source.id, hosts: [...source.hosts], requestedBy: userId },
    title: `${source.label} for ${agent}’s builds`,
    question: [
      `${quoteForCard(asker)} wants to let ${quoteForCard(agent)}’s builds download from ${source.label}.`,
      '',
      `Allows: ${source.hosts.join(', ')}`,
      'Only while it builds. A build could also send data there.',
    ].join('\n'),
  });
  if (!id) throw new ChangeRefused('No owner or admin could be asked right now', 503);
  log.info('Apps: build source sent for approval', { agentGroupId, source: source.id, by: userId, approvalId: id });
  return { change: 'widen', applied: false, pending: true };
}

/** Apply an approved build source. Throws when it no longer holds. */
export async function applyApprovedBuildRegistries(payload: Record<string, unknown>): Promise<string[]> {
  const agentGroupId = String(payload.agentGroupId ?? '');
  const requestedBy = String(payload.requestedBy ?? '');
  const hosts = Array.isArray(payload.hosts) ? payload.hosts.map(String) : [];
  const source = buildSource(payload.source);
  if (!agentGroupId || !requestedBy || !source || hosts.length !== source.hosts.length || !hasSource(hosts, source))
    throw new Error('malformed card');
  if (!publishDeps || !(await publishDeps.isAdmin(requestedBy, agentGroupId)))
    throw new Error('the person who asked no longer administers this agent');
  const next = [...new Set([...(await buildRegistries(agentGroupId)), ...hosts])];
  await setBuildRegistries(agentGroupId, next);
  const what =
    source.id === 'dockerhub'
      ? 'Docker Hub is now allowed for your builds: base images in FROM lines can be pulled from it.'
      : `${source.label} is now allowed for your builds.`;
  await notifyWorkloadAgent(agentGroupId, `[System] ${what} Redeploy to build.`);
  return next;
}

registerSessionlessApprovalHandler(BUILD_REGISTRIES_ACTION, async ({ payload, outcome, userId }) => {
  if (outcome !== 'approve') return;
  try {
    await applyApprovedBuildRegistries(payload);
    log.info('Apps: build source approved and applied', {
      agentGroupId: payload.agentGroupId,
      source: buildSource(payload.source)?.id,
      approvedBy: userId,
    });
  } catch (err) {
    log.warn('Apps: approved build source not applied', {
      agentGroupId: payload.agentGroupId,
      err: String(err).slice(0, 300),
    });
  }
});
