// ── Agent → Apps: loading and actions ───────────────────────────────────────
// The Apps accordion in the agent detail: an agent's apps, their route and who
// can open them, and the person's own actions (start/stop, logs, restore,
// delete). Admins of the agent only: GET /api/agents/:id/apps answers 403 to
// everyone else, and the accordion hides — like Secrets and Learning.
//
// A change that narrows (unpublish, a narrower rule, fewer people) applies at
// once; one that widens or moves route goes to an approval card, whoever asks
// (server: modules/workloads/gui.ts). The row reverts to what is live and
// shows Needs approval until the card is answered.
import { apiJson } from '../core/api.js';
import { $ } from '../core/dom.js';
import { showToast } from '../core/toast.js';
import {
  appsAgentId,
  appsBusy,
  appsDrawer,
  appsErrors,
  appsInfoKey,
  appsMenuKey,
  appsService,
  appsView,
  classifyChange,
  nextForRoute,
  rowKey,
  type AppRow,
  type AppSetting,
  type AppsView,
  type RouteChoice,
  type Who,
} from './apps-state.js';
import { showConfirmModal } from './modals.js';

const base = () => `/api/agents/${encodeURIComponent(appsAgentId.value ?? '')}`;
const nameOf = (r: AppRow) => r.app ?? r.workload;

/** Load the agent's apps into the accordion, or hide it (not an admin, or workloads unused here). */
export async function loadAgentApps(agentId: string): Promise<void> {
  const host = $('#agent-apps');
  const accordion = host?.closest('details') as HTMLElement | null;
  if (!host) return;
  appsAgentId.value = agentId;
  appsMenuKey.value = null;
  appsDrawer.value = null;
  let view: AppsView | null = null;
  try {
    view = await apiJson(`${base()}/apps`);
  } catch {
    view = null;
  }
  if (appsAgentId.value !== agentId) return; // another agent opened meanwhile
  if (!Array.isArray(view?.apps)) view = null; // 403, or not this server's shape
  appsView.value = view;
  const count = $('#agent-apps-count');
  if (count) count.textContent = view?.apps.length ? String(view.apps.length) : '';
  if (accordion) accordion.hidden = !view || (!view.available && view.apps.length === 0);
}

async function reload(): Promise<void> {
  if (appsAgentId.value) await loadAgentApps(appsAgentId.value);
}

function setError(key: string, message: string | null): void {
  const next = new Map(appsErrors.value);
  if (message) next.set(key, message);
  else next.delete(key);
  appsErrors.value = next;
}

/** Run a row's request; a refusal shows on the row (its controls already show what is live). */
async function busy<T>(r: AppRow, fn: () => Promise<T>): Promise<T | undefined> {
  const key = rowKey(r);
  if (appsBusy.value.has(key)) return undefined;
  appsBusy.value = new Set([...appsBusy.value, key]);
  setError(key, null);
  try {
    return await fn();
  } catch (err) {
    setError(key, (err as Error)?.message || 'That did not work');
    return undefined;
  } finally {
    const next = new Set(appsBusy.value);
    next.delete(key);
    appsBusy.value = next;
  }
}

/** Send a change; the server applies a narrowing or raises a card for a widening. */
async function send(r: AppRow, next: AppSetting): Promise<void> {
  const change = classifyChange({ route: r.route, who: r.who, emails: r.emails }, next);
  if (change === 'none') return;
  if (next.route === 'off') {
    const ok = await showConfirmModal({
      title: `Unpublish ${nameOf(r)}?`,
      body: 'Publishing it again needs an approval.',
      confirmLabel: 'Unpublish',
      destructive: true,
    });
    if (!ok) return;
  }
  const out = await busy(r, () =>
    apiJson(`${base()}/apps`, {
      method: 'PUT',
      body: {
        workload: r.workload,
        app: r.app,
        route: next.route,
        who: next.who,
        emails: next.emails,
        ...(r.app ? {} : { service: appsService.value.get(rowKey(r)) ?? r.services[0] }),
      },
    }),
  );
  if (out?.pending) showToast('Sent for approval');
  else if (out?.applied) showToast(next.route === 'off' ? 'Unpublished' : 'Saved', { kind: 'success' });
  await reload();
}

export function onRouteChange(r: AppRow, route: RouteChoice): void {
  void send(r, nextForRoute(r, route));
}

export function onWhoChange(r: AppRow, who: Who): void {
  if (who === 'specific') {
    // The people come first; nothing is sent until they are named.
    appsDrawer.value = { key: rowKey(r), kind: 'people' };
    return;
  }
  void send(r, { route: r.route, who, emails: [] });
}

export function savePeople(r: AppRow, emails: string[]): void {
  appsDrawer.value = null;
  void send(r, { route: r.route, who: 'specific', emails });
}

export function openPeople(r: AppRow): void {
  appsDrawer.value = { key: rowKey(r), kind: 'people' };
}

export function closeMenu(): void {
  appsMenuKey.value = null;
}

export function pickService(r: AppRow, service: string): void {
  appsService.value = new Map(appsService.value).set(rowKey(r), service);
}

export function toggleInfo(r: AppRow): void {
  appsInfoKey.value = appsInfoKey.value === rowKey(r) ? null : rowKey(r);
}

export function closeDrawer(): void {
  appsDrawer.value = null;
}

export function toggleMenu(r: AppRow): void {
  appsMenuKey.value = appsMenuKey.value === rowKey(r) ? null : rowKey(r);
}

const workloadUrl = (r: AppRow, verb = '') =>
  `${base()}/workloads/${encodeURIComponent(r.workload)}${verb ? `/${verb}` : ''}`;

export async function startStop(r: AppRow): Promise<void> {
  appsMenuKey.value = null;
  const verb = r.running ? 'stop' : 'start';
  const out = await busy(r, () => apiJson(workloadUrl(r, verb), { method: 'POST' }));
  if (out) showToast(verb === 'stop' ? 'Stopped' : 'Started', { kind: 'success' });
  await reload();
}

export async function openLogs(r: AppRow): Promise<void> {
  appsMenuKey.value = null;
  const key = rowKey(r);
  appsDrawer.value = { key, kind: 'logs', text: null };
  const out = await busy(r, () => apiJson(workloadUrl(r, 'logs')));
  if (appsDrawer.value?.key !== key) return;
  appsDrawer.value = out ? { key, kind: 'logs', text: String(out.logs ?? '') } : null;
}

export async function openRestore(r: AppRow): Promise<void> {
  appsMenuKey.value = null;
  const key = rowKey(r);
  appsDrawer.value = { key, kind: 'restore', backups: null };
  const out = await busy(r, () => apiJson(workloadUrl(r, 'backups')));
  if (appsDrawer.value?.key !== key) return;
  appsDrawer.value = out ? { key, kind: 'restore', backups: out.backups ?? [] } : null;
}

export async function restore(r: AppRow, stamp: string, at: string): Promise<void> {
  const ok = await showConfirmModal({
    title: `Restore ${r.workload}?`,
    body: `Its data is replaced with the backup of ${at}. The current data is lost.`,
    confirmLabel: 'Restore',
    destructive: true,
  });
  if (!ok) return;
  appsDrawer.value = null;
  const out = await busy(r, () => apiJson(workloadUrl(r, 'restore'), { method: 'POST', body: { backup: stamp } }));
  if (out) showToast('Restored', { kind: 'success' });
  await reload();
}

export async function remove(r: AppRow): Promise<void> {
  appsMenuKey.value = null;
  const ok = await showConfirmModal({
    title: `Delete ${r.workload}?`,
    body: 'Its containers and data are removed. This can’t be undone.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok) return;
  const out = await busy(r, () => apiJson(workloadUrl(r), { method: 'DELETE' }));
  if (out) showToast('Deleted', { kind: 'success' });
  await reload();
}
