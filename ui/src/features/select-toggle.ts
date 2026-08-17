// ── Selectable-model toggle ─────────────────────────────────────────────────
// The +/− control every server row carries. Adding registers the model as a
// selectable (kind decided by the server type); removing deletes the
// selectable — refused with names when agents are assigned to it.
//
// Out of legacy.js because two renderers use it — the Ollama host model list in
// models.ts and the router roster in routing.ts — and neither can become an
// island while the row it builds comes back as a DOM node from legacy.
//
// Same split as origin-badge.ts: selectToggleProps() decides everything the
// control shows, toggleSelectable() is everything the click does, and BOTH
// renderers — the imperative builder here and SelectToggle.vue — are thin over
// them. The one decision that matters is findSelectable's: whether this model
// is already registered, and against which endpoint form.
import { authFetch } from '../core/api.js';
import { allModels } from './model-list-state.js';
import { showToast } from '../core/toast.js';

/** What the toggle needs from the modules that still own this state. */
export interface SelectToggleDeps {
  /** Every registered selectable model row. */
  /** Re-fetch after a change — one pass re-renders selection AND servers. */
  fetchModels: () => Promise<unknown> | unknown;
  /** Keep the Routing tab's roster in sync when it is the visible tab. */
  refreshRouterRoster: () => void;
}

const deps = {} as SelectToggleDeps;

export function provideSelectToggleDeps(provided: Partial<SelectToggleDeps>): void {
  Object.assign(deps, provided);
}

/**
 * The registered selectable matching this server row, if there is one.
 *
 * Endpoint comparison is normalised because the same router has been registered
 * under several host forms over time.
 */
export function findSelectable(kind: string, endpoint: string, modelId: string) {
  const norm = (e: string) => (e || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return allModels.value.find((r: any) => {
    if (r.model_id !== modelId) return false;
    if (kind === 'ollama') return r.kind === 'ollama' && norm(r.endpoint) === norm(endpoint);
    // Router rows: any openai-compatible registration pointing at the router,
    // whichever host form an older registration used (127.0.0.1 vs
    // host.docker.internal, with or without /v1). Port 4000 is LiteLLM's
    // /add-litellm default — mirrored in ollama-manage.ts and bind-routes.mjs.
    return r.kind === 'openai-compatible' && /:4000(\/v1)?$/.test(norm(r.endpoint));
  });
}

/** Everything the control renders, decided once — the seam a component needs. */
export function selectToggleProps(kind: string, endpoint: string, modelId: string) {
  const existing = findSelectable(kind, endpoint, modelId);
  const title = existing ? 'Remove from selectable models' : 'Add to selectable models';
  return {
    existing,
    on: !!existing,
    className: 'btn btn-ghost select-toggle' + (existing ? ' on' : ''),
    label: existing ? '−' : '+',
    title,
  };
}

/**
 * What the +/− click does. Shared by the imperative builder and SelectToggle.vue
 * so the two cannot drift — the component owns none of this.
 *
 * `setBusy` is how the caller disables its own control: the button element in
 * the imperative case, a ref in the component's. It is called with false only
 * on failure, matching the original, because on success fetchModels() re-renders
 * the row away.
 */
export async function toggleSelectable(
  kind: string,
  endpoint: string,
  modelId: string,
  displayName: string,
  setBusy: (busy: boolean) => void,
): Promise<void> {
  const existing = findSelectable(kind, endpoint, modelId);
  setBusy(true);
  try {
    if (existing) {
      const r = await authFetch('/api/models/' + encodeURIComponent(existing.id), { method: 'DELETE' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        const who = (existing.agents || []).map((a: any) => a.name).join(', ');
        throw new Error(who ? 'in use by ' + who + ' — unassign first' : body.error || r.status);
      }
      showToast('Removed from selectable models');
    } else {
      const r = await authFetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: displayName, kind, endpoint, model_id: modelId }),
      });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      showToast('Added to selectable models', { kind: 'success' });
    }
    await deps.fetchModels(); // one pass re-renders selection AND servers
    deps.refreshRouterRoster();
  } catch (err: any) {
    showToast(String(err.message || err), { kind: 'error' });
    setBusy(false);
  }
}

export function buildSelectToggle(kind: string, endpoint: string, modelId: string, displayName: string) {
  const p = selectToggleProps(kind, endpoint, modelId);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = p.className;
  btn.textContent = p.label;
  btn.title = p.title;
  btn.setAttribute('aria-label', btn.title);
  btn.addEventListener('click', () => {
    void toggleSelectable(kind, endpoint, modelId, displayName, (busy) => {
      btn.disabled = busy;
    });
  });
  return btn;
}
