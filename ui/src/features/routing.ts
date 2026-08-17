// ── Routing ──────────────────────────────────────────────────────────────────
// The routing tab: profiles, the model roster, decisions and metrics, and the
// route detail drawer.
import { closeModelDetail } from './models.js';
import { createApp } from 'vue';
import { routeDefaultName, routeRows, routeSelectedIdx, routeSuggestBusy, routeSuggestions } from './route-list-state.js';
import RouteList from './RouteList.vue';
import RouteSuggestions from './RouteSuggestions.vue';
import { manageTab } from './views-state.js';
import { allModels } from './model-list-state.js';
import { routingAvailable, routingClassifierModel, routingCurrentRouter, routingDraft, routingRouterInfo, selectedRouteIdx } from './routing-state.js';
import RoutingDecisions from './RoutingDecisions.vue';
import { decisions as decisionRows, decisionsPhase, decisionsRouter } from './routing-decisions-state.js';
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { showConfirmModal, showInputModal } from './modals.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { fetchModels } from './models.js';
import { switchManageTab } from './views.js';
import RouterRoster from './RouterRoster.vue';
import { rosterEndpoint, rosterSelectable, rosterSystem, rosterUnreachable } from './router-roster-state.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideRoutingDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface RoutingDeps {
}

const deps = {} as RoutingDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideRoutingDeps(provided: Partial<RoutingDeps>): void {
  Object.assign(deps, provided);
}

export async function refreshRouterMetrics() {
  const section = $('#dash-router-section');
  if (!section) return;
  try {
    const res = await authFetch('/api/router/metrics?days=7');
    if (!res.ok) {
      section.hidden = true;
      return;
    }
    const m = await res.json();
    if (!m.available || m.total === 0) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const max = Math.max(...m.byModel.map((x: any) => x.count), 1);
    const bars = m.byModel
      .map(
        (x: any) => `
      <div class="router-bar-row" title="${esc(x.model)}">
        <span class="router-bar-label">${esc(x.model)}</span>
        <span class="router-bar-track"><span class="router-bar-fill" style="width:${Math.max(3, Math.round((100 * x.count) / max))}%"></span></span>
        <span class="router-bar-count">${x.count}</span>
      </div>`,
      )
      .join('');
    const routes = m.byRoute
      .filter((r: any) => r.route !== '__error__')
      .map((r: any) => `${esc(r.route)} ${r.count}`)
      .join(' · ');
    const health = [];
    health.push(`${m.total} request${m.total === 1 ? '' : 's'}`);
    health.push(`${m.live} via auto`);
    if (m.escalations > 0) health.push(`${m.escalations} escalated to Claude`);
    if (m.errors > 0) health.push(`${m.errors} classifier error${m.errors === 1 ? '' : 's'}`);
    $('#dash-router')!.innerHTML =
      `<div class="router-summary">${esc(health.join(' · '))}</div>` +
      bars +
      (routes ? `<div class="router-routes">Routes: ${routes}</div>` : '');
  } catch {
    section.hidden = true;
  }
}

export async function probeRoutingAvailability() {
  try {
    const res = await authFetch('/api/router/routes');
    // The endpoint answers 200 either way; `installed:false` means the routing
    // skill isn't set up (no 404 to log). Treat a missing flag as installed so
    // an older server that still 404s degrades to res.ok.
    const data = await res.json().catch(() => ({}));
    routingAvailable.value = res.ok && data.installed !== false;
    routingClassifierModel.value = data.classifier || null;
  } catch {
    routingAvailable.value = false;
  }
  // Owners see the tab even when routing is NOT installed — the installer
  // lives there now, and a tab that only appears after the thing it installs
  // exists is a door that only unlocks from the inside.
  const reveal = routingAvailable.value || state.isOwnerView;
  document.querySelectorAll('.manage-tab[data-mtab="routing"], .overflow-item[data-action="routing"]').forEach((el: any) => {
    (el as HTMLElement).hidden = !reveal;
  });
  if (!reveal && manageTab.value === 'routing') switchManageTab('agents');
}

export async function loadRoutingTab() {
  try {
    const q = routingCurrentRouter.value ? `?router=${encodeURIComponent(routingCurrentRouter.value)}` : '';
    const [routesRes, rosterRes] = await Promise.all([
      authFetch('/api/router/routes' + q),
      authFetch('/api/router/models'),
    ]);
    if (!routesRes.ok) throw new Error((await routesRes.json()).error || routesRes.status);
    routingDraft.value = await routesRes.json();
    routingCurrentRouter.value = routingDraft.value.router ?? null; // the server tells us which it returned
    routingRouterInfo.value = rosterRes.ok ? await rosterRes.json() : null;
  } catch (err) {
    showToast('Auto routing config unavailable: ' + (err as any)?.message, { kind: 'error' });
    return;
  }
  if (allModels.value.length === 0) await fetchModels(); // ± states need the registry
  renderRouterPicker();
  renderRouteList();
  renderRouterRoster();
  renderRouteSuggestions();
  if (routingSubtab === 'logs') refreshRoutingDecisions();
  $('#routing-bench-result')!.hidden = true;
  $('#routing-bench-result-log')!.hidden = true;
}

function renderRouterPicker() {
  const sel = $('#router-select')!;
  const names = routingDraft.value?.routers ?? [routingCurrentRouter.value ?? 'auto'];
  const picker = $('#router-picker')!;
  // With a single router the picker is redundant — hide it until there's a choice.
  picker.hidden = names.length <= 1;
  sel!.innerHTML = '';
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    if (n === routingCurrentRouter.value) o.selected = true;
    sel!.appendChild(o);
  }
  $<HTMLInputElement>('#router-delete-btn')!.disabled = names.length <= 1;

  void updateRoutingIntro();
}

async function updateRoutingIntro() {
  const intro = $('#routing-intro');
  if (intro) intro.hidden = true;
}

let routingSubtab = 'rules';

export function switchRoutingSubtab(which: any) {
  routingSubtab = which;
  document.querySelectorAll('.routing-subtab').forEach((b: any) => {
    const on = (b as HTMLElement).dataset.rsub === which;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('#rsub-rules')!.hidden = which !== 'rules';
  $('#rsub-models')!.hidden = which !== 'models';
  $('#rsub-logs')!.hidden = which !== 'logs';
  if (which === 'logs') refreshRoutingDecisions();
}

let rosterApp: ReturnType<typeof createApp> | null = null;

function mountRouterRoster(): void {
  if (rosterApp) return;
  const host = $('#router-roster-list');
  if (!host) return;
  rosterApp = createApp(RouterRoster);
  rosterApp.mount(host);
}

export function renderRouterRoster() {
  if (!$('#router-roster-list')) return;
  mountRouterRoster();
  const info = routingRouterInfo.value;
  if (!info || info.models.length === 0) {
    rosterUnreachable.value = true;
    rosterSelectable.value = [];
    rosterSystem.value = [];
    return;
  }
  // The classifier is served by the router but is infrastructure ("never a route
  // target") — list it under a separate, non-selectable "System" group, not with
  // a +/− toggle among the assignable route models.
  const isClassifier = (id: any) => routingClassifierModel.value && id === routingClassifierModel.value;
  rosterEndpoint.value = info.endpoint;
  rosterSelectable.value = info.models.filter((id: any) => !isClassifier(id));
  rosterSystem.value = info.models.filter(isClassifier);
  rosterUnreachable.value = false;
}

export async function saveRoutingConfig() {
  const q = routingCurrentRouter.value ? `?router=${encodeURIComponent(routingCurrentRouter.value)}` : '';
  const res = await authFetch('/api/router/routes' + q, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // Only routes + default_route are editable in the UI. Omitting `live`
    // leaves the server's existing live config (enabled / timeout_ms) untouched
    // — those controls were removed from the UI (live-routing was a footgun for
    // 'auto'-assigned agents; timeout is an install-tuning detail).
    body: JSON.stringify({
      routes: routingDraft.value.routes,
      default_route: routingDraft.value.default_route,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.status);
  routingDraft.value = body;
  renderRouteList();
}

let decisionsApp: ReturnType<typeof createApp> | null = null;

function mountRoutingDecisions(): void {
  if (decisionsApp) return;
  const host = $('#routing-decisions-list');
  if (!host) return;
  decisionsApp = createApp(RoutingDecisions);
  decisionsApp.mount(host);
}

async function refreshRoutingDecisions() {
  if (!$('#routing-decisions-list')) return;
  mountRoutingDecisions();
  try {
    // Over-fetch and filter client-side to the selected profile — the log
    // interleaves every router's traffic. (Legacy lines with no `router` field
    // are attributed to the primary `auto`.)
    const res = await authFetch('/api/router/decisions?limit=60');
    if (!res.ok) throw new Error(String(res.status));
    let { decisions } = await res.json();
    const cur = routingCurrentRouter.value ?? 'auto';
    decisions = decisions.filter((d: any) => (d.router ?? 'auto') === cur).slice(0, 15);
    decisionsRouter.value = cur;
    // Assign the rows BEFORE the phase, so a watcher can never observe the
    // 'rows' phase against the previous profile's data.
    decisionRows.value = decisions;
    decisionsPhase.value = decisions.length === 0 ? 'empty' : 'rows';
  } catch {
    decisionRows.value = [];
    decisionsPhase.value = 'error';
  }
}

// ── Panel wiring ─────────────────────────────────────────────────────────────
// The routing panel: the detail close button, the route detail form, the
// create-route button, and the two classifier bench widgets.
//
// runBench and wireBench are function DECLARATIONS, so moving them alongside
// the statements that call them cannot change execution order — only the two
// wireBench() calls actually run, and they keep their position relative to
// everything else in the slice. Confirmed with the boot-order trace rather than
// argued: see docs/webchat/boot-order-guard.md.

export function wireRoutingPanel(): void {
  // Registered here, first, because it was a top-level statement immediately
  // BEFORE legacy's wireRoutingPanel() call — folding it in keeps that order.
  $('#roster-refresh-btn')?.addEventListener('click', runRosterRefresh);
  $<HTMLButtonElement>('#route-detail-close')?.addEventListener('click', () => closeRouteDetail());

  $<HTMLFormElement>('#route-detail-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const isNew = selectedRouteIdx.value === -1;
    const r = isNew ? { name: '', description: '', model: '' } : routingDraft.value.routes[selectedRouteIdx.value ?? -1];
    if (!r) return;
    const prevName = r.name;
    r.name = ($<HTMLInputElement>('#route-name')?.value ?? '').trim();
    r.description = ($<HTMLTextAreaElement>('#route-description')?.value ?? '');
    if (!r.escalate) {
      r.model = ($<HTMLSelectElement>('#route-binding')?.value ?? '');
      r.pinned = ($<HTMLInputElement>('#route-pinned')?.checked ?? false);
      if (($<HTMLInputElement>('#route-default')?.checked ?? false)) routingDraft.value.default_route = r.name;
      else if (routingDraft.value.default_route === prevName) routingDraft.value.default_route = r.name;
    }
    // Append a new route only now, right before the save that validates it; pop
    // it back off on failure so the draft never keeps an unsaved/invalid row.
    if (isNew) {
      routingDraft.value.routes.push(r);
      selectedRouteIdx.value = routingDraft.value.routes.length - 1;
    }
    try {
      await saveRoutingConfig();
      showToast('Route saved — live now', { kind: 'success' });
      if (isNew) closeRouteDetail();
      else {
        const title = $('#route-detail-title');
        if (title) title.textContent = r.name;
      }
    } catch (err: any) {
      if (isNew) {
        routingDraft.value.routes.pop();
        selectedRouteIdx.value = -1;
      }
      showToast('Save failed: ' + (err as any)?.message, { kind: 'error' });
    }
  });

  $<HTMLButtonElement>('#route-delete')?.addEventListener('click', async () => {
    const r = routingDraft.value.routes[selectedRouteIdx.value ?? -1];
    if (!r) return;
    // Destructive + persisted immediately — the confirm modal is universal at
    // delete sites (DESIGN.md §5); this was the one that slipped through.
    const ok = await showConfirmModal({
      title: `Delete the route "${r.name || r.model || 'unnamed'}"?`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    routingDraft.value.routes.splice(selectedRouteIdx.value, 1);
    try {
      await saveRoutingConfig();
      closeRouteDetail();
      showToast('Route removed');
    } catch (err: any) {
      showToast('Delete failed: ' + (err as any)?.message, { kind: 'error' });
      loadRoutingTab(); // resync the draft we just mutated
    }
  });

  $<HTMLButtonElement>('#create-route-btn')?.addEventListener('click', () => openNewRouteDetail());

  // The classify bench appears at the top of both the Rules and Logs sub-tabs, so
  // tuning and log-reading each have the tester at hand. One helper, two mounts.
  async function runBench(inputEl: HTMLInputElement, outEl: HTMLElement): Promise<void> {
    const prompt = inputEl.value.trim();
    if (!prompt) return;
    outEl.hidden = false;
    outEl.classList.remove('err');
    outEl.textContent = 'Classifying…';
    try {
      const res = await authFetch('/api/router/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      outEl.textContent = `→ ${body.route} · ${body.model ?? '(no binding)'} · ${body.ms} ms`;
    } catch (err: any) {
      // Errors must not read like a green success — flip to the warning colour.
      outEl.classList.add('err');
      outEl.textContent = 'Could not classify — ' + ((err as any)?.message || 'classifier unavailable');
    }
  }
  function wireBench(inputId: string, runId: string, outId: string): void {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const out = document.getElementById(outId);
    if (!input || !out) return;
    document.getElementById(runId)?.addEventListener('click', () => runBench(input, out));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runBench(input, out);
    });
  }
  wireBench('routing-bench-input', 'routing-bench-run', 'routing-bench-result');
  wireBench('routing-bench-input-log', 'routing-bench-run-log', 'routing-bench-result-log');
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// The routing profile list and its selection controls.
//
// One function per GROUP of blocks, each called from the line its group
// started on. Blocks with an executing statement between them cannot share a
// function: a single call at the first block moves the later ones ahead of
// whatever ran in between, which the boot-order trace catches.

export function wireRoutingProfiles(): void {
  $<HTMLButtonElement>('#router-delete-btn')?.addEventListener('click', async () => {
    const name = routingCurrentRouter.value;
    if (!name) return;
    const ok = await showConfirmModal({
      title: 'Delete routing profile',
      body: `Delete the "${name}" routing profile? Agents must be unassigned from it first.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await authFetch('/api/router/routers/' + encodeURIComponent(name), { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.status);
      routingCurrentRouter.value = null; // fall back to primary
      showToast(`Deleted "${name}"`);
      await fetchModels();
      loadRoutingTab();
    } catch (err: any) {
      showToast('Could not delete: ' + (err as any)?.message, { kind: 'error' });
    }
  });
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// The router profile creation control.
//
// These blocks were invisible to the ownership census: no module referenced
// their element ids, because the wiring that would have referenced them was
// still here in legacy.js. Attributed by the subject element's NAME instead.

export function wireRouterNew(): void {
  $<HTMLButtonElement>('#router-new-btn')?.addEventListener('click', async () => {
    const name = await showInputModal({
      title: 'New routing profile',
      placeholder: 'letters, digits, dash',
    });
    if (!name) return;
    try {
      const res = await authFetch('/api/router/routers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `target` was never defined in this scope, so this threw ReferenceError
        // and creating a routing profile was impossible. The server reads only
        // `name` (rRouterRoutersPost, server.ts) — addRouter() clones the primary
        // router as the starting point — so the field was vestigial, not missing.
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.status);
      routingCurrentRouter.value = name; // clone of the current profile; edit from here
      showToast(`Created routing profile "${name}" (cloned)`, { kind: 'success' });
      await fetchModels(); // the new router auto-registered as a model
      loadRoutingTab();
    } catch (err: any) {
      showToast('Could not create profile: ' + (err as any)?.message, { kind: 'error' });
    }
  });
}

// A roster model may have a capability (per the routing skill's catalog) that
// no route covers yet — e.g. adding a vision model with no vision route. Offer
// to create the route with a default description + the best-scoring binding;
// the operator tunes it afterward in Rules. Existing routes still auto-rebind
// via the capability binder — this only fills GAPS.
let routeSuggestApp: any = null;

function mountRouteSuggestions() {
  if (routeSuggestApp) return;
  const host = $('#route-suggestions');
  if (!host) return;
  routeSuggestApp = createApp(RouteSuggestions, {
    onCreate: (s: any) => void createRouteFromSuggestion(s),
  });
  routeSuggestApp.mount(host);
}

export async function renderRouteSuggestions() {
  const box = $('#route-suggestions');
  if (!box) return;
  let suggestions = [];
  try {
    const res = await authFetch('/api/router/suggestions');
    if (res.ok) suggestions = (await res.json()).suggestions || [];
  } catch {
    /* skill not installed / router down — no suggestions */
  }
  routeSuggestions.value = suggestions;
  // The box's own hidden flag: Vue owns the children, not the element.
  box.hidden = suggestions.length === 0;
  mountRouteSuggestions();
}

async function createRouteFromSuggestion(s: any) {
  if (!routingDraft.value) return;
  if (routingDraft.value.routes.some((r: any) => r.name === s.capability)) return; // already added
  routeSuggestBusy.value = new Set(routeSuggestBusy.value).add(s.capability);
  routingDraft.value.routes.push({ name: s.capability, description: s.description, model: s.model });
  try {
    await saveRoutingConfig();
    showToast(`Created ${s.capability} route → ${s.model}`, { kind: 'success' });
    renderRouteSuggestions(); // it drops off the list now that it's covered
  } catch (err) {
    routingDraft.value.routes = routingDraft.value.routes.filter((r: any) => r.name !== s.capability); // roll back
    showToast('Could not create route: ' + (err as any)?.message, { kind: 'error' });
  } finally {
    // Re-enable on BOTH paths. The imperative version only did so on failure,
    // because on success the row was rebuilt away; the busy set outlives the
    // rebuild, so a stale entry would disable a capability that comes back.
    const next = new Set(routeSuggestBusy.value);
    next.delete(s.capability);
    routeSuggestBusy.value = next;
  }
}

// Refresh roster: run the installer chain, stream the log, then re-render.
async function runRosterRefresh() {
  const btn = $<HTMLButtonElement>('#roster-refresh-btn');
  const log = $<HTMLElement>('#roster-refresh-log');
  btn!.disabled = true;
  log!.hidden = false;
  log!.textContent = 'Starting…';
  try {
    const res = await authFetch('/api/router/roster-refresh', { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    while (true) {
      await new Promise((r: any) => setTimeout(r, 2000));
      const st = await (await authFetch('/api/router/roster-refresh')).json();
      log!.textContent = st.lines.slice(-12).join('\n');
      log!.scrollTop = log!.scrollHeight;
      if (!st.running) {
        if (st.exitCode === 0) {
          showToast('Roster refreshed', { kind: 'success' });
          setTimeout(() => { log!.hidden = true; }, 4000);
          loadRoutingTab();
        } else {
          showToast('Roster refresh failed — see log', { kind: 'error' });
        }
        break;
      }
    }
  } catch (err) {
    log!.textContent = 'Refresh failed: ' + (err as any)?.message;
    showToast('Roster refresh failed', { kind: 'error' });
  } finally {
    btn!.disabled = false;
  }
}

// PUT the whole draft (routes + default + live controls) — the server
// validates; the hook picks it up on the next request.



// Same list grammar as Agents/Models/MCP: rows open a detail aside; chips
// carry state (default / pinned / escalates); bound model rides as dim meta.
let routeListApp: any = null;

function mountRouteList() {
  if (routeListApp) return;
  const host = $('#route-list');
  if (!host) return;
  routeListApp = createApp(RouteList, {
    onActivate: (i: any) => {
      if (selectedRouteIdx.value === i && !$('#route-detail')!.hidden) closeRouteDetail();
      else openRouteDetail(i);
    },
  });
  routeListApp.mount(host);
}

export function renderRouteList() {
  if (!$('#route-list')) return;
  routeRows.value = routingDraft.value.routes;
  routeDefaultName.value = routingDraft.value.default_route || '';
  routeSelectedIdx.value = selectedRouteIdx.value ?? -1;
  mountRouteList();
  // detailOpen is a root prop, which Vue reads ONCE — so the open state rides
  // on the selected index instead: -1 whenever the detail pane is closed. Same
  // conclusion the draft-card island reached about root props.
  if ($('#route-detail')!.hidden) routeSelectedIdx.value = -1;
}

// selectedRouteIdx.value === -1 means "new route being drafted in the detail aside" —
// nothing is added to routingDraft.value until Save succeeds, so cancelling leaves no
// phantom row and a failed save doesn't strand one.
export function openRouteDetail(i: number | null) {
  const r = routingDraft.value.routes[i ?? -1];
  if (!r) return;
  selectedRouteIdx.value = i;
  populateRouteDetail(r, false);
}

export function openNewRouteDetail() {
  if (!routingDraft.value) return;
  selectedRouteIdx.value = -1;
  populateRouteDetail({ name: '', description: '', model: (routingRouterInfo.value?.models ?? [])[0] || '' }, true);
}

export function populateRouteDetail(r: any, isNew: boolean) {
  closeModelDetail();
  renderRouteList();

  $('#route-detail-title')!.textContent = isNew ? 'New route' : r.name;
  const badge = $('#route-detail-badge');
  badge!.hidden = !r.escalate;
  if (r.escalate) {
    badge!.className = 'model-kind-badge kind-anthropic';
    badge!.textContent = 'escalate';
  }
  $<HTMLInputElement>('#route-name')!.value = r.name;
  $<HTMLInputElement>('#route-description')!.value = r.description || '';
  $('#route-binding-label')!.hidden = Boolean(r.escalate);
  $('#route-escalate-note')!.hidden = !r.escalate;
  if (!r.escalate) {
    const sel = $('#route-binding');
    sel!.innerHTML = '';
    for (const m of [...new Set([r.model, ...(routingRouterInfo.value?.models ?? [])])].filter(Boolean)) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      if (m === r.model) o.selected = true;
      sel!.appendChild(o);
    }
  }
  const pin = $<HTMLInputElement>('#route-pinned');
  pin!.checked = Boolean(r.pinned);
  pin!.parentElement!.hidden = Boolean(r.escalate);
  const def = $<HTMLInputElement>('#route-default');
  def!.checked = routingDraft.value.default_route === r.name;
  def!.disabled = def!.checked; // pick a new default elsewhere instead of unsetting
  def!.parentElement!.hidden = Boolean(r.escalate);

  $('#route-detail')!.hidden = false;
  $('#members-panel')!.hidden = true;
}

export function closeRouteDetail() {
  $('#route-detail')!.hidden = true;
  selectedRouteIdx.value = null;
  if (routingDraft.value) renderRouteList();
}
