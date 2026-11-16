/**
 * Publishing a workload's service to people: an app name on one publishing
 * route (tailnet or Cloudflare, gateway/publishing.ts), served by the gateway
 * to the people its "who can open" rule lets in.
 *
 * An agent can only ask: expose (and so any widening, or a route change)
 * waits for an owner's card, and the person who says yes becomes the app's
 * "only me". Unexpose is immediate for the agent and for people. Nothing can
 * be exposed until an owner turns a route on.
 */
import { quoteForCard } from '../../card-text.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import { normalizeEmail } from './gateway/access.js';
import { validAddress, validTarget } from './gateway/caddy.js';
import { gatewayState, syncGateway } from './gateway/index.js';
import { isLive } from './gateway/live.js';
import {
  enabledRoutes,
  isRouteKind,
  publishingRoute,
  ROUTE_KIND_WORDS,
  type PublishingRoute,
} from './gateway/publishing.js';
import {
  claimTicket,
  deleteRoute,
  findRouteByApp,
  insertRoute,
  isWho,
  listRoutes,
  updateRoute,
  WHO,
  type AppRoute,
  type Who,
} from './routes.js';
import { findWorkload, getWorkload, type Workload } from './store.js';

/** One DNS label; names starting with "nanoclaw" are NanoClaw's own. */
export const APP_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const WHO_WORDS: Record<Who, string> = {
  'only-me': 'only you',
  specific: 'the people named',
  'agent-members': 'the agent’s members',
  'signed-in': 'anyone signed in to NanoClaw',
};

export function checkAppName(v: string): string {
  const a = v.trim().toLowerCase();
  if (!APP_NAME_RE.test(a) || a.startsWith('nanoclaw') || a.startsWith('xn--'))
    throw new Error('--app must be one name of up to 40 lowercase letters, digits and hyphens, e.g. notes');
  return a;
}

export interface ExposeInput {
  /** The workload. */
  name: string;
  service: string;
  port: number;
  /** The app's name (its address's first label); defaults to the workload's name. */
  app?: string;
  route?: string;
  who?: string;
  /** For --who specific: comma-separated email addresses. */
  emails?: string;
  /** The address an approval card showed: refused when the route would now give another. */
  hostname?: string;
}

/** The most people one app can name (each is a rule in its Access policy). */
export const MAX_EMAILS = 50;

/** --emails: comma- or space-separated addresses, checked, lowercased, deduplicated, sorted. */
export function parseEmails(v: string): string[] {
  const out = new Set<string>();
  for (const raw of v.split(/[\s,;]+/).filter(Boolean)) {
    const e = normalizeEmail(raw);
    if (!e) throw new Error(`${raw.slice(0, 80)} is not an email address`);
    out.add(e);
  }
  if (out.size > MAX_EMAILS) throw new Error(`--emails names at most ${MAX_EMAILS} people`);
  return [...out].sort();
}

/** Does going from `prev` to `next` let anyone in who could not open it before? */
export function widensAccess(prev: { who: Who; emails: string[] }, next: { who: Who; emails: string[] }): boolean {
  if (next.who === 'specific' && prev.who === 'specific') return next.emails.some((e) => !prev.emails.includes(e));
  if (next.who === 'specific') return prev.who === 'only-me';
  if (prev.who === 'specific') return next.who !== 'only-me';
  return WHO.indexOf(next.who) > WHO.indexOf(prev.who);
}

/** Where to publish and who may open it: everything about a publish but the service it serves. */
export interface AccessPlan {
  app: string;
  route: PublishingRoute;
  who: Who;
  /** For `specific`: who, by email. */
  emails: string[];
  hostname: string;
  existing: AppRoute | null;
  /** True when this widens who can open it, or moves it to another route. */
  widens: boolean;
}

export interface ExposePlan extends AccessPlan {
  workload: Workload;
  target: string;
}

/** How Admin → Publishing names a route kind, for "an owner can turn on …". */
const ROUTE_SWITCH: Record<string, string> = { tailnet: 'Tailnet', cloudflare: 'Cloudflare', port: 'Tailnet ports' };

/** The publishing route to use: the one asked for, or the only one that is on. Refused while it is off. */
export async function pickRoute(asked?: string): Promise<PublishingRoute> {
  if (asked !== undefined && !isRouteKind(asked)) throw new Error(`--route must be ${ROUTE_KIND_WORDS}`);
  const on = await enabledRoutes();
  if (asked && !on.some((r) => r.kind === asked))
    throw new Error(
      `the ${asked} route is not on on this host: an owner can turn on ${ROUTE_SWITCH[asked]} in Admin → Publishing`,
    );
  if (!on.length)
    throw new Error('no publishing route is on on this host: an owner can turn one on in Admin → Publishing');
  const g = gatewayState();
  if (!g.ok) throw new Error(`publishing is not available: ${g.reason}`);
  if (asked) return on.find((r) => r.kind === asked)!;
  if (on.length === 1) return on[0];
  throw new Error(`--route is required: ${on.map((r) => r.kind).join(' or ')}`);
}

/**
 * The app name, rule and address on `route`, for a workload that may not
 * exist yet (`workloadId` null: a first deploy that publishes). Shared by
 * expose and a deploy that publishes, so both refuse the same things.
 */
export async function planAccess(
  route: PublishingRoute,
  workloadName: string,
  workloadId: string | null,
  i: Pick<ExposeInput, 'app' | 'who' | 'emails' | 'hostname'>,
): Promise<AccessPlan> {
  const app = checkAppName(i.app || workloadName);
  const existing = await findRouteByApp(app);
  if (existing && existing.workloadId !== workloadId)
    throw new Error(`the app name ${app} is taken: pick another with --app`);
  const whoRaw = i.who ?? existing?.who ?? 'only-me';
  if (!isWho(whoRaw)) throw new Error(`--who must be one of ${WHO.join(', ')}`);
  let emails: string[] = [];
  if (whoRaw === 'specific') {
    if (route.kind !== 'cloudflare') throw new Error('--who specific is for the cloudflare route only');
    emails = i.emails !== undefined ? parseEmails(i.emails) : (existing?.emails ?? []);
    if (!emails.length) throw new Error('--who specific needs --emails: the people who may open it');
  } else if (i.emails !== undefined && i.emails.trim()) {
    throw new Error('--emails goes with --who specific');
  }
  const hostname = await route.hostnameFor(app);
  if (!hostname || !validAddress(hostname))
    throw new Error(`the ${route.kind} route cannot give ${app} an address yet`);
  if (i.hostname !== undefined && i.hostname !== hostname)
    throw new Error(`${app}'s address changed after the approval (now ${hostname}): ask again for a new card`);
  const widens =
    !existing ||
    existing.kind !== route.kind ||
    widensAccess({ who: existing.who, emails: existing.emails }, { who: whoRaw, emails });
  return { app, route, who: whoRaw, emails, hostname, existing, widens };
}

/** Everything that can be refused before an owner sees a card; re-run right before the change. */
export async function planExpose(agentGroupId: string, i: ExposeInput): Promise<ExposePlan> {
  const route = await pickRoute(i.route);
  const w = await findWorkload(agentGroupId, i.name);
  if (!w) throw new Error(`you have no workload named "${i.name}"`);
  const addr = w.addresses[i.service];
  if (!addr)
    throw new Error(`no service "${i.service}" in ${w.name}${w.state === 'running' ? '' : ' (deploy it first)'}`);
  if (!Number.isInteger(i.port) || i.port < 1 || i.port > 65535) throw new Error('--port must be 1–65535');
  const target = `${addr}:${i.port}`;
  if (!validTarget(target)) throw new Error(`${i.service} has no workload address`);
  return { ...(await planAccess(route, w.name, w.id, i)), workload: w, target };
}

/** The first port a service declares under `expose:`, or null. */
export function declaredPort(def: { expose?: unknown }): number | null {
  const ex = Array.isArray(def.expose) ? def.expose : [];
  const port = ex
    .map((x) => /^(\d{1,5})(\/tcp)?$/.exec(String(x))?.[1])
    .map(Number)
    .find((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
  return port ?? null;
}

/**
 * Which service and port a deploy that publishes serves, from the stack
 * itself (it has no addresses yet): the one asked for, or the only service
 * that declares an `expose:` port. Pure.
 */
export function publishTarget(
  services: Record<string, { expose?: unknown }>,
  service?: string,
  port?: number,
): { service: string; port: number } {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error('--port must be 1–65535');
  if (service) {
    const def = services[service];
    if (!def) throw new Error(`no service "${service}" in the stack`);
    const p = port ?? declaredPort(def);
    if (!p) throw new Error(`--port is required: ${service} declares no \`expose:\` port`);
    return { service, port: p };
  }
  const found = Object.entries(services)
    .map(([name, def]) => ({ service: name, port: declaredPort(def) }))
    .filter((t): t is { service: string; port: number } => t.port !== null);
  if (found.length === 1) return { service: found[0].service, port: port ?? found[0].port };
  if (!found.length)
    throw new Error('--service is required: no service declares an `expose:` port (or add one, e.g. expose: ["8080"])');
  throw new Error(`--service is required: ${found.map((t) => t.service).join(' or ')}`);
}

/** "only you", "2 named people": who can open it, as a card says it. */
export function whoText(p: { who: Who; emails: string[] }): string {
  return p.who === 'specific'
    ? `${p.emails.length} named ${p.emails.length === 1 ? 'person' : 'people'}`
    : WHO_WORDS[p.who];
}

/** The lines a card shows for a publish: address, what it serves, who can open it (and who could before). */
export function accessCardLines(p: AccessPlan, serves: string): string[] {
  const was = p.existing
    ? `${p.existing.who === 'specific' ? `${p.existing.emails.length} named` : WHO_WORDS[p.existing.who]}${p.existing.kind !== p.route.kind ? `, on ${p.existing.kind}` : ''}`
    : '';
  return [
    `Address: https://${p.hostname}/`,
    `Serves: ${serves}`,
    `Who can open: ${whoText(p)}${p.existing ? ` (was: ${was})` : ''}`,
    ...(p.who === 'specific' ? [`People: ${p.emails.map((e) => quoteForCard(e)).join(', ')}`] : []),
  ];
}

/** What a card pins for a publish: the route, rule, name and address it showed, and the approver's ticket. */
export const accessPin = (p: AccessPlan, ticket: string): Record<string, string> => ({
  route: p.route.kind,
  who: p.who,
  app: p.app,
  hostname: p.hostname,
  ...(p.who === 'specific' ? { emails: p.emails.join(',') } : {}),
  ticket,
});

export interface Exposer {
  /** The person exposing it, or null for an agent (its approver is filled in by ticket) or the host. */
  userId: string | null;
  /** An agent's approval ticket (pinned on the card). */
  ticket?: string | null;
  createdBy: string;
}

export async function exposeApp(agentGroupId: string, i: ExposeInput, by: Exposer): Promise<AppRoute> {
  const p = await planExpose(agentGroupId, i);
  let r: AppRoute;
  if (p.existing) {
    r = await updateRoute(p.existing.id, {
      service: i.service,
      port: i.port,
      kind: p.route.kind,
      who: p.who,
      emails: p.emails,
      // A person exposing it again makes it theirs; an agent's re-expose keeps whoever it belongs to.
      ...(by.userId ? { ownerUserId: by.userId, ticket: null } : {}),
      ...(!by.userId && !p.existing.ownerUserId ? { ticket: by.ticket ?? null } : {}),
    });
  } else {
    r = await insertRoute({
      app: p.app,
      workloadId: p.workload.id,
      agentGroupId,
      service: i.service,
      port: i.port,
      kind: p.route.kind,
      who: p.who,
      emails: p.emails,
      ownerUserId: by.userId,
      ticket: by.userId ? null : (by.ticket ?? null),
      createdBy: by.createdBy,
    });
  }
  await syncGateway();
  // An app moved off a route leaves that route's edge; its new route brings one up.
  if (p.existing && p.existing.kind !== r.kind) await publishingRoute(p.existing.kind)?.detach?.(p.existing);
  await p.route.attach?.(r);
  return r;
}

export async function unexposeApp(agentGroupId: string, app: string): Promise<{ app: string; unpublished: true }> {
  const a = app.trim().toLowerCase();
  const r = await findRouteByApp(a);
  if (!r || r.agentGroupId !== agentGroupId) throw new Error(`you have no published app named "${app}"`);
  await deleteRoute(r.id);
  await syncGateway();
  await publishingRoute(r.kind)?.detach?.(r);
  return { app: a, unpublished: true };
}

/** A route row as an agent or person reads it. */
export async function routeView(r: AppRoute): Promise<Record<string, unknown>> {
  const w = await getWorkload(r.workloadId);
  const kind = publishingRoute(r.kind);
  const on = kind ? await kind.enabled().catch(() => false) : false;
  const hostname = on && kind ? await kind.hostnameFor(r.app).catch(() => null) : null;
  const live = await isLive(r);
  const g = gatewayState();
  const edge = live && kind?.edgeState ? await kind.edgeState(r).catch(() => ({ ready: false })) : { ready: true };
  const problem = 'problem' in edge ? edge.problem : undefined;
  return {
    app: r.app,
    workload: w?.name ?? null,
    service: r.service,
    port: r.port,
    route: r.kind,
    who: r.who,
    ...(r.who === 'specific' ? { emails: r.emails } : {}),
    url: live && edge.ready && hostname && g.ok ? `https://${hostname}/` : null,
    state: !g.ok
      ? 'gateway off'
      : !on
        ? 'route off'
        : !w || w.state !== 'running'
          ? 'workload not running'
          : live
            ? edge.ready
              ? 'live'
              : problem
                ? `not reachable: ${problem}`
                : 'starting'
            : 'not reachable',
  };
}

export async function routesOf(agentGroupId: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of await listRoutes({ agentGroupId })) out.push(await routeView(r));
  return out;
}

/**
 * How a PERSON opens a workload, in words an agent can pass on as is: its
 * live links and who may use them, or that it is not published. Never the
 * private service addresses.
 */
export async function openLine(w: Workload): Promise<string> {
  const views = await Promise.all((await listRoutes({ workloadId: w.id })).map(routeView));
  const live = views.filter((v) => v.url);
  if (live.length)
    return `People open it at: ${live.map((v) => `${String(v.url)} (${WHO_WORDS[v.who as Who] ?? String(v.who)})`).join('; ')}`;
  if (views.length)
    return `Published, but not open now (${views.map((v) => `${String(v.app)}: ${String(v.state)}`).join('; ')}).`;
  return 'Not published: people cannot open it. `ncl workloads expose` asks an owner to publish it.';
}

/** Routes whose workload was deleted go with it. */
export async function pruneRoutes(): Promise<number> {
  let n = 0;
  for (const r of await listRoutes()) {
    const w = await getWorkload(r.workloadId);
    if (!w || w.state === 'deleted') {
      await deleteRoute(r.id);
      await publishingRoute(r.kind)
        ?.detach?.(r)
        .catch(() => undefined);
      n++;
    }
  }
  if (n) await syncGateway();
  return n;
}

/** The commands whose card carries a publish ticket: expose, and a deploy that publishes. */
const TICKET_COMMANDS = new Set(['workloads-expose', 'workloads-up']);

/**
 * The person who approves an agent's expose card (or its deploy-and-publish
 * card) is who "only me" means for it. An automatic approval (the pre-judge) names no person and is ignored;
 * workloads expose is never auto-approved anyway (approvals/prejudge.ts).
 */
export function approverOf(event: {
  approval: { action: string; payload: string };
  outcome: string;
  userId: string;
}): { ticket: string; userId: string } | null {
  if (event.outcome !== 'approve' || event.approval.action !== 'cli_command') return null;
  if (!/^[a-z][a-z0-9-]*:./.test(event.userId) || event.userId.startsWith('prejudge:')) return null;
  try {
    const p = JSON.parse(event.approval.payload) as { frame?: { command?: unknown; args?: Record<string, unknown> } };
    const command = p.frame?.command;
    const ticket = typeof command === 'string' && TICKET_COMMANDS.has(command) ? p.frame?.args?.ticket : undefined;
    return typeof ticket === 'string' && /^[0-9a-f-]{36}$/.test(ticket) ? { ticket, userId: event.userId } : null;
  } catch {
    return null;
  }
}

registerApprovalResolvedHandler(async (event) => {
  const a = approverOf(event);
  if (a) await claimTicket(a.ticket, a.userId);
});
