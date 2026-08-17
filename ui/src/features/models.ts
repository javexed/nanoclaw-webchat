// ── Models ───────────────────────────────────────────────────────────────────
// The models surface: the catalog and its detail pane, provider/kind labelling,
// the known-model dropdowns other panels populate, and the manage view.
import { createApp, watchEffect } from 'vue';
import { probeEmptyNote, probeRows, probeSingle } from './probe-results-state.js';
import ProbeResults from './ProbeResults.vue';
import { selectedAgentId } from './agent-list-state.js';
import { pickerEmptyNote, pickerRows, pickerSelected } from './model-picker-state.js';
import ModelPicker from './ModelPicker.vue';
import Reachability from './Reachability.vue';
import { reachError, reachOutcome, reachPhase } from './reachability-state.js';
import { routingAvailable, routingClassifierModel } from './routing-state.js';
import ModelList from './ModelList.vue';
import { allModels, lastProbeResult, modelRows, modelSortAz, selectedModelId } from './model-list-state.js';
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { showConfirmModal } from './modals.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { closeAgentDetail, endpointHost, fetchAgents, openAgentDetail, refreshAgentModelTrigger, refreshAgentSaveDirty } from './agents.js';
import { closeMcpDetail } from './mcp.js';
import { closeRoomDetail, openRoomDetail } from './rooms.js';
import { buildSelectToggle } from './select-toggle.js';
import ModelUsage from './ModelUsage.vue';
import { modelAssignees } from './model-usage-state.js';
import { loadOllamaHosts } from './ollama-cards.js';
import { hostModels } from './ollama-cards-state.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideModelsDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface ModelsDeps {
  closeRouteDetail: () => any;
  makeRowActivatable: (...args: any[]) => any;
  switchManageTab: (a0?: any) => any;
}

/** A model card, with the cached summary node hung on it. */
interface ModelCard extends HTMLElement {
  _summary?: HTMLElement;
}

const deps = {} as ModelsDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
export function provideModelsDeps(provided: Partial<ModelsDeps>): void {
  Object.assign(deps, provided);
}

export function sttPopulateModelSelect(st?: any) {
  const select = ($('#stt-model-select')) as HTMLInputElement;
  if (!select || !Array.isArray(st.models)) return;
  if ((select as unknown as HTMLSelectElement).options.length === 0) {
    for (const m of st.models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m === st.suggestedModel ? `${m} (suggested)` : m;
      select.appendChild(opt);
    }
  }
  select.value = st.model || st.suggestedModel || st.models[0];
}

let knownModelOptions: any = null;

export async function populateKnownModelOptions() {
  const list = $('#agent-config-model-options')!;
  if (!list) return;
  if (knownModelOptions === null) {
    try {
      const res = await authFetch('/api/models/known');
      knownModelOptions = res.ok ? (await res.json()).models || [] : [];
    } catch {
      knownModelOptions = [];
    }
  }
  if (list.childElementCount === knownModelOptions.length) return;
  list.textContent = '';
  for (const id of knownModelOptions) {
    const opt = document.createElement('option');
    opt.value = id;
    list.appendChild(opt);
  }
}

export async function fetchModels() {
  try {
    const res = await authFetch('/api/models');
    allModels.value = await res.json();
    renderModels();
    loadOllamaHosts();
  } catch (err: any) {
    console.error('Failed to fetch models:', err);
  }
}

export async function loadOllamaHostModels(host?: any) {
  try {
    const res = await authFetch('/api/ollama/models?host=' + encodeURIComponent(host));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.status);
    // The routing classifier is a model on the host but not an agent model — list
    // it in a separate, non-selectable "System" group rather than offering a "+"
    // that would register infrastructure as a selectable chat model.
    const isClassifier = (m?: any) => routingClassifierModel.value && m.name === routingClassifierModel.value;
    hostModels.value[host] = {
      phase: 'ready',
      selectable: body.models.filter((m: any) => !isClassifier(m)),
      system: body.models.filter(isClassifier),
      error: '',
    };
  } catch (err: any) {
    hostModels.value[host] = { phase: 'error', selectable: [], system: [], error: 'Unreachable: ' + (err as any)?.message };
  }
}

export function modelKindLabel(kind?: any) {
  return kind === 'openai-compatible' ? 'openai' : kind;
}

export function isRouterBackendModel(m?: any) {
  if (m.kind !== 'openai-compatible' || m.model_id === 'auto') return false;
  const host = (m.endpoint || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return /:4000(\/v1)?$/.test(host);
}

function modelDisplayParts(model?: any) {
  const host = model.endpoint ? model.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '') : null;
  let title = model.name;
  if (host && title.startsWith(host + ' \u00b7 ')) title = title.slice(host.length + 3);
  return { title, host };
}

function modelKindExplainer(kind?: any) {
  // Local/compat endpoints need no prose \u2014 the kind badge already says it, and
  // reachability is now shown live below. Keep only the anthropic note, which
  // conveys the distinct per-request credential model.
  if (kind === 'anthropic') return 'Anthropic model \u2014 credentials injected per request by the OneCLI gateway.';
  return '';
}

let modelListApp: ReturnType<typeof createApp> | null = null;

/** Mount the ModelList island into <ul id="model-list">, once. */
function mountModelList(): void {
  if (modelListApp) return;
  const host = $('#model-list');
  if (!host) return;
  modelListApp = createApp(ModelList, {
    onPick: (id: string) => {
      const row = allModels.value.find((m: any) => m.id === id);
      if (row?.model_id === 'auto') {
        // Send owners to where 'auto' is actually configured; the detail sheet
        // has nothing meaningful for a virtual model.
        if (routingAvailable.value) deps.switchManageTab('routing');
        else openModelDetail(id);
        return;
      }
      const detail = $('#model-detail');
      if (selectedModelId.value === id && detail && !detail.hidden) closeModelDetail();
      else openModelDetail(id);
    },
    onRemove: async (id: string, btn: HTMLButtonElement) => {
      btn!.disabled = true;
      try {
        const r = await authFetch('/api/models/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          const model = allModels.value.find((m: any) => m.id === id);
          const who = (model?.agents || []).map((a: any) => a.name).join(', ');
          throw new Error(who ? 'in use by ' + who + ' — unassign first' : body.error || r.status);
        }
        showToast('Removed from selectable models');
        if (selectedModelId.value === id) closeModelDetail();
        fetchModels();
      } catch (err: any) {
        showToast(String((err as any)?.message || err), { kind: 'error' });
        btn!.disabled = false;
      }
    },
  });
  modelListApp.mount(host);

  // `POST /api/models` carries guards:['owner']. Viewing the catalog stays open
  // — knowing which models exist is useful to anyone — but the create button is
  // owner-only, so hide it rather than let it 403. Watcher, not a one-shot: the
  // list can render before probeIsOwner resolves.
  watchEffect(() => {
    const btn = $('#create-model-btn');
    if (btn) btn.hidden = !state.isOwnerView;
  });
}

export function renderModels(): void {
  // Router backends (openai-compatible :4000 registrations) are managed in
  // Auto routing → Models, not here — keep this list to real selectables.
  const visible = allModels.value.filter((m: any) => !isRouterBackendModel(m));
  const byName = (a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
  const sorted = modelSortAz.value
    ? [...visible].sort(byName)
    : [...visible].sort(
        (a: any, b: any) => (a.kind === 'anthropic' ? 0 : 1) - (b.kind === 'anthropic' ? 0 : 1) || byName(a, b),
      );
  modelRows.value = sorted.map((model: any) => {
    // The virtual routing model ('auto') stores kind 'openai-compatible' because
    // it points at the LiteLLM router, but that badge reads as a provider it is
    // not. Give it an honest 'auto' badge and a navigate hint instead of a host.
    const isAuto = model.model_id === 'auto';
    const parts = modelDisplayParts(model);
    return {
      id: model.id,
      badgeKind: isAuto ? 'auto' : model.kind,
      badgeText: isAuto ? 'auto' : modelKindLabel(model.kind),
      title: parts.title,
      host: isAuto ? null : (parts.host ?? null),
      hint: isAuto ? 'Manage in Auto routing →' : null,
      uses: model.agents_assigned ?? 0,
      active: model.id === selectedModelId.value,
    };
  });
  mountModelList();
}


let modelUsageApp: ReturnType<typeof createApp> | null = null;

function mountModelUsage(): void {
  if (modelUsageApp) return;
  const host = $('#model-detail-usage');
  if (!host) return;
  modelUsageApp = createApp(ModelUsage);
  modelUsageApp.mount(host);
}

export async function openModelDetail(id?: any) {
  const model = allModels.value.find((m: any) => m.id === id);
  if (!model) return;
  selectedModelId.value = id;
  renderModels();
  if (typeof deps.closeRouteDetail === 'function') deps.closeRouteDetail();
  closeAgentDetail();
  closeRoomDetail();
  closeMcpDetail();

  $('#model-edit-view')!.hidden = false;
  $('#model-create-view')!.hidden = true;

  const parts = modelDisplayParts(model);
  $('#model-detail-title')!.textContent = parts.title;
  const badge = $('#model-detail-badge')!;
  badge.textContent = modelKindLabel(model.kind);
  badge.className = `model-kind-badge kind-${model.kind}`;
  badge.hidden = false;
  const kindExplainer = modelKindExplainer(model.kind);
  $('#model-kind-explainer')!.textContent = kindExplainer;
  $('#model-kind-explainer')!.hidden = !kindExplainer;
  $<HTMLInputElement>('#model-name')!.value = model.name;
  // The RAW kind rides on the hidden input because the Browse (discover)
  // button reads it back as the API `kind` parameter.
  $<HTMLInputElement>('#model-kind')!.value = modelKindLabel(model.kind);
  $('#model-kind')!.dataset.kind = model.kind;
  $<HTMLInputElement>('#model-endpoint')!.value = model.endpoint || '';
  $('#model-endpoint-label')!.hidden = model.kind !== 'ollama';
  $<HTMLInputElement>('#model-model-id')!.value = model.model_id;
  $('#model-discover-select')!.hidden = true;
  loadModelLiveFacts(model);
  renderReachabilityPanel(model);

  // The assignee line is an island; everything above only SETS values on static
  // markup, which is why only this block converts.
  modelAssignees.value = (model.agents || []).map((a: any) => a.name);
  mountModelUsage();


  // Rooms this model reaches (via its assigned agents) — click one to open its
  // settings. Hidden entirely when the model isn't wired into any room.
  const roomsEl = $('#model-detail-rooms')!;
  roomsEl.innerHTML = '';
  if (model.rooms && model.rooms.length > 0) {
    roomsEl.hidden = false;
    roomsEl.appendChild(document.createTextNode('In rooms: '));
    for (const r of model.rooms) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'model-assignee-chip model-room-chip';
      chip.textContent = r.name;
      chip.title = 'Open room settings';
      chip.addEventListener('click', () => openRoomDetail(r.id));
      roomsEl.appendChild(chip);
    }
  } else {
    roomsEl.hidden = true;
  }

  $('#model-detail')!.hidden = false;
  $('#members-panel')!.hidden = true;
}

async function loadModelLiveFacts(model?: any) {
  const el = $('#model-live-facts')!;
  el!.hidden = true;
  el!.classList.remove('warn');
  if (model.kind !== 'ollama' || !model.endpoint) return;
  try {
    const res = await authFetch('/api/ollama/models?host=' + encodeURIComponent(model.endpoint));
    if (!res.ok) return; // non-owner or unreachable — facts are best-effort
    const { models } = await res.json();
    if (selectedModelId.value !== model.id) return; // panel moved on
    const hit = models.find((m: any) => m.name === model.model_id);
    if (!hit) {
      el!.textContent = 'Not installed on this endpoint \u2014 pull it below or pick another model id.';
      el!.classList.add('warn');
    } else {
      const gb = (hit.size / 1e9).toFixed(1);
      el!.textContent = hit.loaded
        ? `Installed \u00b7 ${gb} GB \u00b7 in memory (${(hit.size_vram / 1e9).toFixed(1)} GB VRAM)`
        : `Installed \u00b7 ${gb} GB`;
    }
    el!.hidden = false;
  } catch {
    /* best-effort */
  }
}

export function closeModelDetail() {
  $('#model-detail')!.hidden = true;
  $('#model-edit-view')!.hidden = false;
  $('#model-create-view')!.hidden = true;
  selectedModelId.value = null;
  renderModels();
}

export async function discoverModels(kind?: any, endpoint?: any) {
  const body = kind === 'anthropic' ? { kind } : { kind, endpoint };
  const res = await authFetch('/api/models/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || 'discover failed');
  return out.models || [];
}

export function openModelPicker() {
  const picker = $('#model-picker')!;
  picker.hidden = false;
  // Force reflow so the open-state transition runs from the initial state.
  void picker.offsetHeight;
  picker.classList.add('open');
  $<HTMLInputElement>('#model-picker-search')!.value = '';
  renderPickerList('');
  // Autofocus the search on desktop only — mobile autofocus pops the
  // soft keyboard immediately, which is jarring when you're scanning a list.
  if (window.matchMedia('(min-width: 720px)').matches) {
    setTimeout(() => $('#model-picker-search')!.focus(), 60);
  }
}

export function closeModelPicker() {
  const picker = $('#model-picker')!;
  picker.classList.remove('open');
  // Wait for the slide-out animation before hiding so the close is animated.
  setTimeout(() => {
    picker.hidden = true;
  }, 220);
}


export function bindDiscover(
  buttonId: string,
  kindGetter: () => string,
  endpointGetter: () => string,
  modelIdInput: string,
  selectEl: string,
): void {
  const btn = $<HTMLButtonElement>(buttonId);
  if (!btn) return;
  btn!.addEventListener('click', async () => {
    const kind = kindGetter();
    const endpoint = endpointGetter();
    if (kind === 'ollama' && !endpoint) {
      showToast('Enter an Ollama endpoint first (e.g. http://localhost:11434)', { kind: 'error' });
      return;
    }
    const original = btn!.textContent;
    btn!.disabled = true;
    btn!.textContent = '…';
    try {
      const models = await discoverModels(kind, endpoint);
      const select = $<HTMLSelectElement>(selectEl);
      if (!select) return;
      select.innerHTML = '<option value="">— pick a model —</option>';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        select.appendChild(opt);
      }
      select.hidden = models.length === 0;
      if (models.length === 0) showToast('No models found at that endpoint.', { kind: 'error' });
      select.onchange = () => {
        const target = $<HTMLInputElement>(modelIdInput);
        if (select.value && target) {
          target.value = select.value;
          select.hidden = true;
        }
      };
    } catch (err: any) {
      showToast('Discover failed: ' + (err as any)?.message, { kind: 'error' });
    } finally {
      btn!.disabled = false;
      btn!.textContent = original;
    }
  });
}

// ── Panel wiring ─────────────────────────────────────────────────────────────
// The model roster panel: add/edit form, endpoint controls, discovery and the
// reachability probe.
//
// A function rather than module-scope code: legacy.js runs its blocks in source
// order around initApp(), so relocating them to another module's top level would
// silently re-order them. legacy calls wireModelsPanel() at the exact line the
// first block occupied, so execution order is unchanged.

export function wireModelsPanel(): void {
  bindDiscover(
    '#model-discover-btn',
    // Raw kind from the data attribute — the visible value is the display label,
    // which the discover API wouldn't recognize.
    () =>
      $<HTMLInputElement>('#model-kind')?.dataset.kind || ($<HTMLInputElement>('#model-kind')?.value ?? ''),
    () => ($<HTMLInputElement>('#model-endpoint')?.value ?? '').trim(),
    '#model-model-id',
    '#model-discover-select',
  );
  $<HTMLFormElement>('#model-create-form')?.addEventListener('submit', async (e: any) => {
    e.preventDefault();
    const body = {
      name: ($<HTMLInputElement>('#model-create-name')?.value ?? '').trim(),
      kind: ($<HTMLSelectElement>('#model-create-kind')?.value ?? ''),
      model_id: ($<HTMLInputElement>('#model-create-model-id')?.value ?? '').trim(),
      endpoint: ($<HTMLInputElement>('#model-create-endpoint')?.value ?? '').trim() || null,
    };
    if (!body.name || !body.model_id) {
      showToast('Name and Model ID are required.', { kind: 'error' });
      return;
    }
    try {
      const res = await authFetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) {
        showToast('Failed to create model: ' + (out.error || res.statusText), { kind: 'error' });
        return;
      }
      warnIfUnreachable(out.reachability);
      await fetchModels();
      closeModelDetail();
      // If the picker kicked off this add, auto-assign + return to agent.
      const createdId = out.model && out.model.id;
      if (createdId) {
        await maybeAssignAfterPickerAdd([createdId]);
      }
    } catch (err: any) {
      showToast('Failed to create model: ' + (err as any)?.message, { kind: 'error' });
    }
  });

  $<HTMLFormElement>('#model-detail-form')?.addEventListener('submit', async (e: any) => {
    e.preventDefault();
    if (!selectedModelId.value) return;
    const btn = $<HTMLButtonElement>('#model-detail-form button.btn-primary');
    if (!btn) return;
    const original = btn!.textContent;
    btn!.disabled = true;
    btn!.textContent = 'Saving…';
    btn!.classList.remove('success');
    const patch = {
      name: ($<HTMLInputElement>('#model-name')?.value ?? '').trim(),
      model_id: ($<HTMLInputElement>('#model-model-id')?.value ?? '').trim(),
      endpoint: ($<HTMLInputElement>('#model-endpoint')?.value ?? '').trim() || null,
    };
    try {
      const res = await authFetch(`/api/models/${encodeURIComponent(selectedModelId.value)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const out = await res.json();
      if (!res.ok) {
        showToast('Failed to save model: ' + (out.error || res.statusText), { kind: 'error' });
        btn!.textContent = original;
        btn!.disabled = false;
        return;
      }
      await fetchModels();
      btn!.textContent = '✓ Saved';
      btn!.classList.add('success');
      setTimeout(() => {
        if (btn.isConnected) {
          btn!.textContent = original;
          btn!.classList.remove('success');
          btn!.disabled = false;
        }
      }, 1500);
    } catch (err: any) {
      showToast('Failed to save model: ' + (err as any)?.message, { kind: 'error' });
      btn!.textContent = original;
      btn!.disabled = false;
    }
  });

  $<HTMLButtonElement>('#model-delete')?.addEventListener('click', async () => {
    if (!selectedModelId.value) return;
    const model = allModels.value.find((m: any) => m.id === selectedModelId.value);
    if (!model) return;
    // First DELETE: server returns 409 with the impact list. We surface it
    // and prompt; on confirm we re-DELETE with ?force=1.
    try {
      const res = await authFetch(`/api/models/${encodeURIComponent(selectedModelId.value)}`, { method: 'DELETE' });
      if (res.status === 409) {
        const impact = await res.json();
        const n = (impact.assigned_agent_group_ids || []).length;
        const routes = impact.routes_bound || [];
        const parts = [];
        if (n > 0) {
          parts.push(
            `"${model.name}" is assigned to ${n} agent${n === 1 ? '' : 's'} — they fall back to the default model on their next spawn.`,
          );
        }
        if (routes.length > 0) {
          // The rule goes WITH the model — say which ones, per router.
          parts.push(
            `Also removes routing rule${routes.length === 1 ? '' : 's'}: ` +
              routes.map((r: any) => `${r.route} (${r.router})`).join(', ') +
              '.',
          );
        }
        const confirmed = await showConfirmModal({
          title: 'Delete model',
          body: parts.join(' ') || impact.error || 'This model is in use.',
          confirmLabel: 'Delete anyway',
          destructive: true,
        });
        if (!confirmed) return;
        const force = await authFetch(`/api/models/${encodeURIComponent(selectedModelId.value)}?force=1`, { method: 'DELETE' });
        if (!force.ok) {
          const err = await force.json().catch(() => ({}));
          showToast(`Failed to delete: ${err.error || force.statusText}`, { kind: 'error' });
          return;
        }
      } else if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(`Failed to delete: ${err.error || res.statusText}`, { kind: 'error' });
        return;
      }
      showToast(`Deleted model "${model.name}".`, { kind: 'success' });
      closeModelDetail();
      await fetchModels();
      // Refresh the agents list too — assigned_model_id may have changed for some.
      if (state.allAgents.length > 0) await fetchAgents();
    } catch (err: any) {
      showToast(`Failed to delete: ${(err as any)?.message}`, { kind: 'error' });
    }
  });

  // ── MCP server registry (the MCP tab) ───────────────────────────────────────
  //
  // Mirrors the models registry: a list pane, a detail/create aside, and a probe
  // that connects to a URL as a real MCP client and lists the server's tools
  // before saving. Servers defined here are attached to agents from the agent
  // panel (many-to-many, unlike a model's 1:1 assignment).

}

// ── Panel wiring ───────────────────────────────────────────────────────────
// Blocks the census read as multi-owner: the union of every id they touch spans
// several modules, but the element each one WIRES belongs here.

export function wireModelCreate(): void {
  $<HTMLButtonElement>('#create-model-btn')?.addEventListener('click', () => {
    selectedModelId.value = null;
    renderModels();
    const el1 = $('#model-edit-view');
    if (el1) el1.hidden = true;
    const el2 = $('#model-create-view');
    if (el2) el2.hidden = false;
    const _el1 = $<HTMLInputElement>('#model-create-name');
      if (_el1) _el1.value = '';
    const _el2 = $<HTMLInputElement>('#model-create-endpoint');
      if (_el2) _el2.value = '';
    const _el3 = $<HTMLInputElement>('#model-create-model-id');
      if (_el3) _el3.value = '';
    const h1 = $<HTMLSelectElement>('#model-create-discover-select');
    if (h1) h1.hidden = true;
    // Reset kind to default + sync conditional fields
    const _el4 = $<HTMLSelectElement>('#model-create-kind');
      if (_el4) _el4.value = 'anthropic';
    syncCreateFormToKind();
    // Reset the probe block (used between successive opens)
    const _el5 = $<HTMLInputElement>('#model-probe-url');
      if (_el5) _el5.value = '';
    const el3 = $('#model-probe-status');
    if (el3) el3.hidden = true;
    const el4 = $('#model-probe-results');
    if (el4) el4.hidden = true;
    lastProbeResult.value = null;
    const el5 = $('#model-detail');
    if (el5) el5.hidden = false;
    const el6 = $('#members-panel');
    if (el6) el6.hidden = true;
    $<HTMLInputElement>('#model-probe-url')?.focus();
  });
}

export function syncCreateFormToKind() {
  const kind = $<HTMLSelectElement>('#model-create-kind')!.value;
  // Endpoint field shows for ollama AND openai-compatible — both need an endpoint.
  $('#model-create-endpoint-label')!.hidden = kind === 'anthropic';
  const placeholders: Record<string, string> = {
    anthropic: 'claude-sonnet-4-6',
    ollama: 'llama3.1:70b',
    'openai-compatible': 'gpt-4o-mini or qwen2.5:14b',
  };
  $<HTMLInputElement>('#model-create-model-id')!.placeholder = placeholders[kind] || '';
}

export function mmBadge(text: string, kind: string) {
  const b = document.createElement('span');
  b.className = 'mm-badge ' + (kind || '');
  b.textContent = text;
  return b;
}

// ── Model management (Settings → Models, owner-only) ──
// Space before the unit, matching the model rows on the same card ("5.2 GB").
// The two sat side by side reading "5.2 GB" and "9.3GB" once the pull preview
// moved under the input.
export function mmFmtGB(bytes: number) {
  return bytes == null ? '?' : (bytes / 1e9).toFixed(1) + ' GB';
}

// ── Container-side reachability preflight ──────────────────────────────────
// The model probe validates from the host, but the agent runs in a container.
// A loopback endpoint the host reaches becomes host.docker.internal in the
// container — a path a firewall or loopback-only bind can silently drop, which
// surfaces only as endless "API retry". These helpers make that visible.
const REACH_META: Record<string, { label: string; warn: boolean }> = {
  ok: { label: 'Reachable', warn: false },
  timeout: { label: 'Blocked (timeout)', warn: true },
  refused: { label: 'Refused', warn: true },
  dns: { label: "Can't resolve", warn: true },
  incompatible: { label: 'Reachable, wrong API', warn: true },
  skipped: { label: 'Not preflighted', warn: false },
  error: { label: 'Probe error', warn: true },
};

// Toast a concise warning when a just-registered/assigned model isn't reachable
// from a container. Opening the model re-runs the check and shows the full fix.
export function warnIfUnreachable(result: any) {
  if (!result || !REACH_META[result.verdict] || !REACH_META[result.verdict].warn) return;
  showToast(`Agent containers can't reach this model — ${result.detail} Open the model to see the fix.`, {
    kind: 'error',
    timeout: 10000,
  });
}

// Render (or refresh) the reachability panel inside the open model detail.
// Bumped on every model-detail open so a slow (container-spawning) probe that
// returns after the operator switched models can't paint the wrong panel.
let reachabilityReqSeq : any = 0;
let reachabilityApp : any = null;

export function mountReachability(panel: any) {
  if (reachabilityApp) return;
  reachabilityApp = createApp(Reachability, {
    onCopy: async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        showToast('Copy failed — select the text manually.', { kind: 'error' });
        return false;
      }
    },
  });
  reachabilityApp.mount(panel);
}

export async function renderReachabilityPanel(model: any) {
  const facts = $('#model-live-facts');
  if (!facts) return;
  let panel = $('#model-reachability-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'model-reachability-panel';
    panel.className = 'model-reachability';
    facts.insertAdjacentElement('afterend', panel);
  }
  // Only endpoints an agent dials directly (loopback → host.docker.internal)
  // are meaningful to probe; hide the panel for hosted Anthropic models.
  if (!model.endpoint) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  reachPhase.value = 'checking';
  reachOutcome.value = null;
  mountReachability(panel);

  // Probe automatically on open — no button. Spins a throwaway container, so it
  // takes a few seconds; the reqId/selectedModelId.value guards drop a stale result.
  const reqId = ++reachabilityReqSeq;
  try {
    const res = await authFetch('/api/models/reachability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: model.endpoint }),
    });
    if (reqId !== reachabilityReqSeq || selectedModelId.value !== model.id) return;
    const result = await res.json();
    if (!res.ok) {
      reachError.value = result.error || res.statusText;
      reachPhase.value = 'error';
      return;
    }
    const meta = REACH_META[result.verdict] || REACH_META.error;
    reachOutcome.value = { warn: !!meta.warn, label: meta.label, detail: result.detail, fix: result.fix || '' };
    reachPhase.value = 'outcome';
  } catch (err) {
    if (reqId !== reachabilityReqSeq) return;
    reachError.value = String((err as any)?.message || err);
    reachPhase.value = 'error';
  }
}

//
// Bottom-sheet (mobile) / centered popover (desktop) for assigning a model
// to the open agent. Default is always pinned at the top. Search filters by
// name + model_id + endpoint host. "+ Add new model" delegates to the
// existing model-detail create flow with a flag set so we auto-assign on
// success.

export let pickerAddInProgress = false;
export let pickerAgentForAdd : any = null;



let modelPickerApp : any = null;

export function mountModelPicker() {
  if (modelPickerApp) return;
  const host = $('#model-picker-list');
  if (!host) return;
  modelPickerApp = createApp(ModelPicker, { onPick: (id: string) => selectFromPicker(id) });
  modelPickerApp.mount(host);
}

export function renderPickerList(filterText?: string) {
  if (!$('#model-picker-list')) return;
  const q = (filterText || '').trim().toLowerCase();
  pickerSelected.value = $<HTMLInputElement>('#agent-model')!.value || '';

  // When no model is assigned but the agent runs on a non-Claude provider, the
  // Default row's sub should name that model — showing "Built-in Anthropic"
  // there would be contradictory.
  const derived = state.allAgents.find((a: any) => a.id === selectedAgentId.value)?.effective_model_label;

  const matches = allModels.value.filter((m: any) => {
    // Routing backends (openai-compatible :4000) are managed in Auto routing →
    // Models, not assignable here — the 'auto' entry represents routing instead.
    // Mirrors renderModels so the picker and the Models list agree.
    if (isRouterBackendModel(m)) return false;
    if (!q) return true;
    const host = endpointHost(m.endpoint).toLowerCase();
    return [m.name, m.model_id, host, m.kind].some((s: any) => (s || '').toLowerCase().includes(q));
  });

  pickerEmptyNote.value =
    allModels.value.length === 0
      ? 'No models registered yet. Use "+ Add new model" below.'
      : matches.length === 0 && q
        ? `No models match "${filterText}".`
        : '';

  // The Default row is pinned at the top and never filtered out — the user may
  // be searching precisely to confirm nothing matches and the fallback is what
  // they want.
  pickerRows.value = [
    {
      key: '__default__',
      id: '',
      isDefault: true,
      name: 'Default',
      badgeClass: 'model-kind-badge model-default-badge',
      badgeText: 'default',
      sub: derived ? `${derived} · auto-detected` : 'Built-in Anthropic',
    },
    ...matches.map((m: any) => {
      const host = endpointHost(m.endpoint);
      return {
        key: m.id,
        id: m.id,
        isDefault: false,
        name: m.name,
        badgeClass: `model-kind-badge kind-${m.kind}`,
        badgeText: modelKindLabel(m.kind),
        sub: host ? `${m.model_id} · ${host}` : m.model_id,
      };
    }),
  ];
  mountModelPicker();
}


export function selectFromPicker(modelId: string) {
  $<HTMLInputElement>('#agent-model')!.value = modelId;
  refreshAgentModelTrigger();
  refreshAgentSaveDirty(); // a model change is a savable edit
  closeModelPicker();
  // Note: we don't auto-persist on select. Existing flow waits for the
  // agent-detail Save button, matching the pre-picker behavior.
}


/**
 * Called from both the manual create and the probe bulk-add success paths.
 * If the picker initiated this add, assign the newly-created model to the
 * agent and return the user to the agent detail. Bulk-add of >1 doesn't
 * auto-assign — we leave the user on the agent detail and they can re-open
 * the picker to choose explicitly.
 */
export async function maybeAssignAfterPickerAdd(createdIds: any) {
  if (!pickerAddInProgress) return false;
  const agentId = pickerAgentForAdd;
  pickerAddInProgress = false;
  pickerAgentForAdd = null;
  if (!agentId) return false;
  // Persist the assignment server-side (the same endpoint the agent Save
  // handler hits). Then refresh the agent detail so the trigger shows the
  // new model.
  if (createdIds.length === 1) {
    try {
      const mRes = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: createdIds[0] }),
      });
      if (mRes.ok) warnIfUnreachable((await mRes.json()).reachability);
    } catch (err) {
      console.error('Auto-assign new model failed:', err);
    }
  }
  // Re-fetch agents so the in-memory list has the new assignment.
  await fetchAgents();
  // Reopen the agent detail so the user lands back where they started.
  if (typeof openAgentDetail === 'function') {
    await openAgentDetail(agentId);
  }
  return true;
}

/** The picker's "+ Add new model" flow sets these from legacy's wiring block,
 *  which cannot assign an imported binding — so it goes through a setter. */
export function setPickerAdd(inProgress: boolean, agentId: any): void {
  pickerAddInProgress = inProgress;
  pickerAgentForAdd = agentId;
}

let probeResultsApp: any = null;

export function mountProbeResults() {
  if (probeResultsApp) return;
  const host = $('#model-probe-list');
  if (!host) return;
  probeResultsApp = createApp(ProbeResults);
  probeResultsApp.mount(host);
}

export function renderProbeResults(probe: any) {
  const summary = $('#model-probe-results .model-probe-summary');
  const kindBadge = summary!.querySelector('.model-probe-kind');
  const notesEl = summary!.querySelector('.model-probe-notes');
  kindBadge!.className = `model-probe-kind kind-${probe.kind}`;
  kindBadge!.textContent = modelKindLabel(probe.kind);
  notesEl!.textContent = probe.notes || '';

  if (!$('#model-probe-list')) return;
  // Auth-gated endpoint or no models advertised — let the user type a model id
  // in the Advanced section instead.
  probeEmptyNote.value = probe.requires_credential
    ? 'Endpoint detected, but the model list is gated. Use the Advanced section below to add a specific model id manually.'
    : 'No models advertised — use the Advanced section to add manually.';
  const host = (() => {
    try {
      return new URL(probe.endpoint).host;
    } catch {
      return probe.endpoint;
    }
  })();
  // Display name defaults to "<host> · <model_id>".
  probeRows.value = probe.models.map((modelId: any) => ({ modelId, name: `${host} · ${modelId}` }));
  probeSingle.value = probe.models.length === 1;
  mountProbeResults();
  $('#model-probe-results')!.hidden = false;
}

export async function addSelectedFromProbe() {
  if (!lastProbeResult.value || !lastProbeResult.value.kind) return;
  const checked = Array.from(document.querySelectorAll('#model-probe-list input[type=checkbox]:checked'));
  if (checked.length === 0) {
    showToast('Select at least one model.', { kind: 'error' });
    return;
  }
  const items = checked.map((cb: any) => {
    const li = cb.closest('li');
    const nameInput = li!.querySelector('input[type=text]');
    return {
      name: (nameInput?.value || cb.value).trim(),
      kind: lastProbeResult.value.kind,
      endpoint: lastProbeResult.value.endpoint,
      model_id: cb.value,
    };
  });
  const btn = $<HTMLButtonElement>('#model-probe-add-selected');
  const original = btn!.textContent;
  btn!.disabled = true;
  btn!.textContent = `Adding ${items.length}…`;
  try {
    const res = await authFetch('/api/models/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: items }),
    });
    const out = await res.json();
    if (!res.ok) {
      showToast('Bulk add failed: ' + (out.error || res.statusText), { kind: 'error' });
      return;
    }
    if (out.failed && out.failed.length > 0) {
      const lines = out.failed.map((f: any) => `  • ${items[f.index].model_id}: ${f.error}`).join('\n');
      showToast(`Added ${out.created_count}, ${out.failed.length} failed:\n${lines}`, { kind: 'error' });
    }
    await fetchModels();
    closeModelDetail();
    // If the picker kicked off this add, return user to the agent detail
    // and auto-assign the new model when there's exactly one.
    const createdIds = (out.created || []).map((m: any) => m.id);
    await maybeAssignAfterPickerAdd(createdIds);
  } catch (err) {
    showToast('Bulk add failed: ' + (err as any)?.message, { kind: 'error' });
  } finally {
    btn!.disabled = false;
    btn!.textContent = original;
  }
}

export async function runProbe() {
  const url = $<HTMLInputElement>('#model-probe-url')!.value.trim();
  if (!url) {
    showToast('Enter a URL or host first (e.g. localhost:11434, api.anthropic.com).', { kind: 'error' });
    return;
  }
  // Scheme is optional — server races http+https when omitted. Reject only
  // obvious garbage (whitespace, angle brackets) early so we don't burn a
  // round-trip on malformed input.
  if (/\s|[<>]/.test(url)) {
    showToast('URL contains invalid characters.', { kind: 'error' });
    return;
  }
  const status = $<HTMLInputElement>('#model-probe-status');
  const results = $<HTMLElement>('#model-probe-results');
  status!.classList.remove('error');
  status!.textContent = 'Probing…';
  status!.hidden = false;
  results!.hidden = true;
  $<HTMLButtonElement>('#model-probe-btn')!.disabled = true;
  try {
    const res = await authFetch('/api/models/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = await res.json();
    if (!res.ok) {
      status!.textContent = body.error || `Probe failed (${res.status})`;
      status!.classList.add('error');
      return;
    }
    lastProbeResult.value = body;
    if (!body.kind) {
      status!.textContent = body.reason || 'No known provider responded.';
      status!.classList.add('error');
      return;
    }
    status!.hidden = true;
    renderProbeResults(body);
  } catch (err) {
    status!.textContent = 'Probe failed: ' + (err as any)?.message;
    status!.classList.add('error');
  } finally {
    $<HTMLButtonElement>('#model-probe-btn')!.disabled = false;
  }
}
