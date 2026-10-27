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
}

export interface AppsView {
  available: boolean;
  routes: RouteKind[];
  disk: { usedGb: number; quotaGb: number; level: 'ok' | 'warn' | 'over' } | null;
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

/** What a route change asks for: the row's rule where the new route takes it, else Only me. */
export function nextForRoute(row: Pick<AppRow, 'route' | 'who' | 'emails'>, route: RouteChoice): AppSetting {
  if (route === 'off') return { route, who: row.who, emails: row.emails };
  if (row.route === 'off') return { route, who: 'only-me', emails: [] };
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
