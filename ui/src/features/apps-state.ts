// ── Agent → Apps: state and decisions ───────────────────────────────────────
// Pure logic for the Apps accordion (AgentApps.vue), unit-tested in
// apps-state.test.ts. The server decides for real (modules/workloads/gui.ts
// classifyChange); this copy lets the row say up front whether a change
// applies at once ("narrow") or goes to an approval card ("widen").
import { ref, shallowRef } from 'vue';

export type RouteKind = 'tailnet' | 'cloudflare';
export type RouteChoice = 'off' | RouteKind;
export type Who = 'only-me' | 'specific' | 'agent-members' | 'signed-in';
export type AppState = 'running' | 'stopped' | 'needs-approval';
export type Change = 'none' | 'narrow' | 'widen';

export interface AppRow {
  app: string | null;
  workload: string;
  state: AppState;
  route: RouteChoice;
  who: Who;
  emails: string[];
  url: string | null;
  canPublish: boolean;
  /** Unpublished: the services it can be published as; a choice when more than one. */
  services: string[];
  deployed: boolean;
  running: boolean;
  /** When it stops unless extended (ms); null: it does not expire. */
  expiresAt: number | null;
  /** Published: renewed near its expiry while people open it. Absent from an older server. */
  renewsWhileUsed?: boolean;
  /** Hosts its services may call at runtime, as approved. Absent from an older server. */
  canCall?: string[];
  /** Calls its services were refused lately. */
  egressRefused?: number;
}

/** A build source (Docker Hub, npm, …): on, or a card to turn it on waiting. */
export interface BuildSourceRow {
  id: string;
  label: string;
  on: boolean;
  pending: boolean;
}

export interface AppsView {
  available: boolean;
  routes: RouteKind[];
  disk: { usedGb: number; quotaGb: number; level: 'ok' | 'warn' | 'over' } | null;
  /** Confined builds on this host, and the package sources this agent's builds may download from. */
  builds?: { on: boolean; sources: BuildSourceRow[] };
  apps: AppRow[];
}

export interface AppSetting {
  route: RouteChoice;
  who: Who;
  emails: string[];
}

/** Narrowest first. */
export const WHO_ORDER: readonly Who[] = ['only-me', 'specific', 'agent-members', 'signed-in'];

/** Does `next` let in anyone `prev` did not? Mirrors publish.ts widensAccess. */
export function widensAccess(prev: { who: Who; emails: string[] }, next: { who: Who; emails: string[] }): boolean {
  if (next.who === 'specific' && prev.who === 'specific') return next.emails.some((e) => !prev.emails.includes(e));
  if (next.who === 'specific') return prev.who === 'only-me';
  if (prev.who === 'specific') return next.who !== 'only-me';
  return WHO_ORDER.indexOf(next.who) > WHO_ORDER.indexOf(prev.who);
}

/** Narrow (applies at once), widen (approval card), or nothing. Mirrors gui.ts classifyChange. */
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

const ROUTE_LABEL: Record<RouteChoice, string> = { off: 'Off', tailnet: 'Tailnet', cloudflare: 'Cloudflare' };

/** Off, plus the routes that are on — and the row's own route even when it was switched off since. */
export function routeOptions(
  enabled: readonly RouteKind[],
  current: RouteChoice,
): Array<{ value: RouteChoice; label: string }> {
  const kinds = (['tailnet', 'cloudflare'] as const).filter((k) => enabled.includes(k) || k === current);
  return [{ value: 'off', label: ROUTE_LABEL.off }, ...kinds.map((k) => ({ value: k, label: ROUTE_LABEL[k] }))];
}

const WHO_LABEL: Record<Who, string> = {
  'only-me': 'Only me',
  'agent-members': 'Agent members',
  'signed-in': 'Anyone signed in',
  specific: 'Specific people…',
};

/** Who can open it, for a route: Cloudflare adds Specific people…. None while Off. */
export function whoOptions(route: RouteChoice): Array<{ value: Who; label: string }> {
  if (route === 'off') return [];
  const order: Who[] =
    route === 'cloudflare'
      ? ['only-me', 'agent-members', 'signed-in', 'specific']
      : ['only-me', 'agent-members', 'signed-in'];
  return order.map((value) => ({ value, label: WHO_LABEL[value] }));
}

export const STATE_LABEL: Record<AppState, string> = {
  running: 'Running',
  stopped: 'Stopped',
  'needs-approval': 'Needs approval',
};

/** What a route change asks for: the row's rule where the new route takes it; a new app opens to Agent members. */
export function nextForRoute(row: Pick<AppRow, 'route' | 'who' | 'emails'>, route: RouteChoice): AppSetting {
  if (route === 'off') return { route, who: row.who, emails: row.emails };
  if (row.route === 'off') return { route, who: 'agent-members', emails: [] };
  if (row.who === 'specific' && route !== 'cloudflare') return { route, who: 'only-me', emails: [] };
  return { route, who: row.who, emails: row.who === 'specific' ? row.emails : [] };
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** A typed list of addresses: split on commas, semicolons or spaces; lowercased, deduplicated, sorted. Bad ones listed apart. */
export function parseEmailList(text: string): { emails: string[]; bad: string[] } {
  const ok = new Set<string>();
  const bad: string[] = [];
  for (const raw of text.split(/[\s,;]+/).filter(Boolean)) {
    if (EMAIL.test(raw)) ok.add(raw.toLowerCase());
    else bad.push(raw);
  }
  return { emails: [...ok].sort(), bad };
}

/** The row's identity in the list: its app name, or its workload while unpublished. */
export const rowKey = (r: Pick<AppRow, 'app' | 'workload'>): string => (r.app ? `app:${r.app}` : `w:${r.workload}`);

/** "1.2 GB of 20 GB". */
export function diskText(d: AppsView['disk']): string {
  if (!d) return '';
  const n = (v: number) => (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  return `${n(d.usedGb)} GB of ${n(d.quotaGb)} GB`;
}

const DAY_MS = 86_400_000;
/** As the server's reminder (reconcile.ts EXPIRY_NOTICE_MS): from here on the date is a warning. */
export const EXPIRY_SOON_MS = 3 * DAY_MS;

/** "1 Dec" in the viewer's own words for a date. */
export const shortDay = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short' });

/**
 * "Expires 1 Dec" (soon: within three days) or "Expired 1 Dec"; null when it
 * does not expire. A published app is renewed while people open it, so until
 * it is close (then it was not used: the date is the warning) it says
 * "Renews while used".
 */
export function expiryText(
  expiresAt: number | null,
  now = Date.now(),
  locale?: string,
  renewsWhileUsed = false,
): { text: string; level: 'ok' | 'soon' | 'past' } | null {
  if (expiresAt === null) return null;
  const day = shortDay(expiresAt, locale);
  if (expiresAt <= now) return { text: `Expired ${day}`, level: 'past' };
  if (expiresAt - now <= EXPIRY_SOON_MS) return { text: `Expires ${day}`, level: 'soon' };
  return renewsWhileUsed ? { text: 'Renews while used', level: 'ok' } : { text: `Expires ${day}`, level: 'ok' };
}

// Reactive state the island renders from (apps.ts fills it).
export const appsView = shallowRef<AppsView | null>(null);
export const appsAgentId = ref<string | null>(null);
/** The row whose ⋯ menu is open. */
export const appsMenuKey = ref<string | null>(null);
/** One drawer open at a time: logs, restore or the people list, for one row. */
export const appsDrawer = shallowRef<
  | null
  | { key: string; kind: 'logs'; text: string | null }
  | { key: string; kind: 'restore'; backups: Array<{ stamp: string; at: string }> | null }
  | { key: string; kind: 'people' }
>(null);
/** A refused change, shown on its row until the next change there. */
export const appsErrors = ref<Map<string, string>>(new Map());
/** Unpublished rows with several services: the one picked. */
export const appsService = ref<Map<string, string>>(new Map());
/** The row whose ⓘ is open. */
export const appsInfoKey = ref<string | null>(null);
/** Rows with a request in flight. */
export const appsBusy = ref<Set<string>>(new Set());
/** Build sources: the one with a request in flight, and a refusal shown under them. */
export const appsBuildsBusy = ref<string | null>(null);
export const appsBuildsError = ref('');
