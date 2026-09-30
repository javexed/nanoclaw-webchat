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
import { $, esc } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { showConfirmModal, showInputModal } from './modals.js';
import { showToast } from '../core/toast.js';
import { apiJson, authFetch } from '../core/api.js';
import { state } from '../core/state.js';
import { fetchModels } from './models.js';
import { switchManageTab } from './views.js';
import RouterRoster from './RouterRoster.vue';
import { rosterEndpoint, rosterSelectable, rosterSystem, rosterUnreachable } from './router-roster-state.js';

export async function refreshRouterMetrics() {
  const section = $('#dash-router-section');
  if (!section) return;
  try {
    const m = await apiJson('/api/router/metrics?days=7');
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
    if (m.errors > 0) health.push(`${m.errors} classifier error${m.errors === 1 ? '' : 's'}`);
    $('#dash-router')!.innerHTML =
      `<div class="router-summary">${esc(health.join(' · '))}</div>` +
      bars +
      (routes ? `<div class="router-routes">Routes: ${routes}</div>` : '');
  } catch {
    section.hidden = true;
  }
}

// The Routing tab exists only when the LLM stack answers: the routing skill
// installed (routes.json present) AND the viewer is the owner — anyone else
// gets no tab, no menu item, no dead surface. Probed lazily, re-checked when
// the manage view opens so installing the stack shows up without a reload.
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
  // lives there, and a tab that only appears after the thing it installs
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
    const [draft, rosterRes] = await Promise.all([apiJson('/api/router/routes' + q), authFetch('/api/router/models')]);
    routingDraft.value = draft;
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

// The router (profile) picker: a dropdown of all routers + new/delete. Shown
// only when the config exposes a routers list (multi-router aware). Switching
// reloads the tab for the selected router.
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

// DESIGN.md §6 (prose budget): the intro is a PREREQUISITE hint, so it only
// exists while the prerequisite is unmet — no agent routes through this
// profile yet. Once the router's model is assigned somewhere, the line goes
// away; the controls explain themselves.
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
  rosterApp ??= mountIsland('#router-roster-list', () => createApp(RouterRoster));
}

// Router models: the LiteLLM roster with the same +/− selection controls as
// the Ollama host cards — one row per roster model, nothing else.
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

// PUT the whole draft (routes + default + live controls) — the server
// validates; the hook picks it up on the next request.
export async function saveRoutingConfig() {
  const q = routingCurrentRouter.value ? `?router=${encodeURIComponent(routingCurrentRouter.value)}` : '';
  routingDraft.value = await apiJson('/api/router/routes' + q, {
    method: 'PUT',
    // Only routes + default_route are editable in the UI. Omitting `live`
    // leaves the server's live config (enabled / timeout_ms) untouched: toggling
    // live routing breaks 'auto'-assigned agents, and timeout is install tuning.
    body: {
      routes: routingDraft.value.routes,
      default_route: routingDraft.value.default_route,
    },
  });
  renderRouteList();
}

let decisionsApp: ReturnType<typeof createApp> | null = null;

function mountRoutingDecisions(): void {
  decisionsApp ??= mountIsland('#routing-decisions-list', () => createApp(RoutingDecisions));
}

async function refreshRoutingDecisions() {
  if (!$('#routing-decisions-list')) return;
  mountRoutingDecisions();
  try {
    // Over-fetch and filter client-side to the selected profile — the log
    // interleaves every router's traffic. (Lines with no `router` field are
    // attributed to the primary `auto`.)
    let { decisions } = await apiJson('/api/router/decisions?limit=60');
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
// create-route button, and the two classifier bench widgets. runBench and
// wireBench are hoisted declarations; only the wireBench() calls affect boot
// order (docs/webchat/boot-order-guard.md).

export function wireRoutingPanel(): void {
  // Registered first: boot order places it just before the rest of this panel.
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
    r.model = ($<HTMLSelectElement>('#route-binding')?.value ?? '');
    r.pinned = ($<HTMLInputElement>('#route-pinned')?.checked ?? false);
    if (($<HTMLInputElement>('#route-default')?.checked ?? false)) routingDraft.value.default_route = r.name;
    else if (routingDraft.value.default_route === prevName) routingDraft.value.default_route = r.name;
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
    // Destructive + persisted immediately — confirm, as at every delete site (DESIGN.md §5).
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
      const body = await apiJson('/api/router/classify', { method: 'POST', body: { prompt } });
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
// One function per run of boot statements: a call cannot span an executing statement without reordering boot.

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
      await apiJson('/api/router/routers/' + encodeURIComponent(name), { method: 'DELETE' });
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

export function wireRouterNew(): void {
  $<HTMLButtonElement>('#router-new-btn')?.addEventListener('click', async () => {
    const name = await showInputModal({
      title: 'New routing profile',
      placeholder: 'letters, digits, dash',
    });
    if (!name) return;
    try {
      // Only `name`: the server's addRouter() clones the primary router.
      await apiJson('/api/router/routers', { method: 'POST', body: { name } });
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
  routeSuggestApp ??= mountIsland('#route-suggestions', () =>
    createApp(RouteSuggestions, {
      onCreate: (s: any) => void createRouteFromSuggestion(s),
    }),
  );
}

export async function renderRouteSuggestions() {
  const box = $('#route-suggestions');
  if (!box) return;
  let suggestions = [];
  try {
    suggestions = (await apiJson('/api/router/suggestions')).suggestions || [];
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
    // Re-enable on BOTH paths: the busy set outlives the re-render, so a stale
    // entry would disable a capability that comes back.
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
    await apiJson('/api/router/roster-refresh', { method: 'POST' });
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

// Same list grammar as Agents/Models/MCP: rows open a detail aside; chips
// carry state (default / pinned); bound model rides as dim meta.
let routeListApp: any = null;

function mountRouteList() {
  routeListApp ??= mountIsland('#route-list', () =>
    createApp(RouteList, {
      onActivate: (i: any) => {
        if (selectedRouteIdx.value === i && !$('#route-detail')!.hidden) closeRouteDetail();
        else openRouteDetail(i);
      },
    }),
  );
}

export function renderRouteList() {
  if (!$('#route-list')) return;
  routeRows.value = routingDraft.value.routes;
  routeDefaultName.value = routingDraft.value.default_route || '';
  routeSelectedIdx.value = selectedRouteIdx.value ?? -1;
  mountRouteList();
  // detailOpen is a root prop, which Vue reads ONCE — so the open state rides
  // on the selected index instead: -1 whenever the detail pane is closed.
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
  $<HTMLInputElement>('#route-name')!.value = r.name;
  $<HTMLInputElement>('#route-description')!.value = r.description || '';
  const sel = $('#route-binding');
  sel!.innerHTML = '';
  for (const m of [...new Set([r.model, ...(routingRouterInfo.value?.models ?? [])])].filter(Boolean)) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    if (m === r.model) o.selected = true;
    sel!.appendChild(o);
  }
  const pin = $<HTMLInputElement>('#route-pinned');
  pin!.checked = Boolean(r.pinned);
  const def = $<HTMLInputElement>('#route-default');
  def!.checked = routingDraft.value.default_route === r.name;
  def!.disabled = def!.checked; // pick a new default elsewhere instead of unsetting

  $('#route-detail')!.hidden = false;
  $('#members-panel')!.hidden = true;
}

export function closeRouteDetail() {
  $('#route-detail')!.hidden = true;
  selectedRouteIdx.value = null;
  if (routingDraft.value) renderRouteList();
}
