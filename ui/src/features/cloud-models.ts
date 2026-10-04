// Manage → Models → Cloud model (owners): a provider, a model and its key.
// The key goes to the OneCLI vault (server); the router installs or reloads,
// then the model is registered like any other and assigned per agent.
import { watchEffect } from 'vue';

import { $ } from '../core/dom.js';
import { apiJson, authFetch } from '../core/api.js';
import { state } from '../core/state.js';
import { showToast } from '../core/toast.js';
import { cloudModelNames } from './cloud-models-state.js';
import { fetchModels, renderModels } from './models.js';

interface CloudInfo {
  providers: Array<{ id: string; label: string }>;
  router: { installed: boolean; endpoint: string };
  models: string[];
  /** Providers whose key the vault already holds. */
  stored: string[];
}
let info: CloudInfo | null = null;

export async function loadCloudModels(): Promise<void> {
  if (!state.isOwnerView) return;
  try {
    info = (await apiJson('/api/models/cloud')) as CloudInfo;
  } catch {
    return;
  }
  cloudModelNames.clear();
  for (const m of info.models) cloudModelNames.add(m);
  // The Models list may have rendered before these were known, hiding them as router backends.
  renderModels();
  render();
}

/** With the provider's key stored: the key is optional, and the model field suggests its own ids. */
async function providerChanged(): Promise<void> {
  if (!info) return;
  const provider = $<HTMLSelectElement>('#cloud-provider')!.value;
  const stored = info.stored.includes(provider);
  $<HTMLInputElement>('#cloud-api-key')!.placeholder = stored ? 'Stored' : 'API key';
  const list = $('#cloud-model-options')!;
  list.replaceChildren();
  if (!stored) return;
  try {
    const { models } = (await apiJson(`/api/models/cloud/models?provider=${encodeURIComponent(provider)}`)) as {
      models: string[];
    };
    if ($<HTMLSelectElement>('#cloud-provider')!.value !== provider) return;
    for (const id of models) list.append(new Option(id, id));
  } catch {
    /* no list: type the id */
  }
}

function render(): void {
  if (!info) return;
  const sel = $<HTMLSelectElement>('#cloud-provider');
  if (sel && !sel.options.length) {
    for (const p of info.providers) sel.add(new Option(p.label, p.id));
  }
  void providerChanged();
  $('#cloud-router-badge')!.hidden = !info.router.installed;
  const btn = $<HTMLButtonElement>('#cloud-model-add')!;
  if (!btn.disabled) btn.textContent = info.router.installed ? 'Add' : 'Install';
}

// A router install pulls an image and restarts a container; past this the page stops watching.
const ROUTER_INSTALL_WATCH_MS = 10 * 60_000;

async function waitForRouter(log: HTMLElement): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const res = await authFetch('/api/router/litellm-install');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Couldn't read the router install: ${err.error || `HTTP ${res.status}`}`);
    }
    const st = await res.json();
    if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-12).join('\n');
    if (!st.running) return st.exitCode === 0;
    if (Date.now() - started > ROUTER_INSTALL_WATCH_MS)
      throw new Error('Router still installing after 10 minutes: check back in Models later');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function add(e: Event): Promise<void> {
  e.preventDefault();
  if (!info) return;
  const provider = $<HTMLSelectElement>('#cloud-provider')!.value;
  const modelInput = $<HTMLInputElement>('#cloud-model-id')!;
  const keyInput = $<HTMLInputElement>('#cloud-api-key')!;
  const modelId = modelInput.value.trim();
  if (!modelId || (!keyInput.value.trim() && !info.stored.includes(provider))) return;
  const btn = $<HTMLButtonElement>('#cloud-model-add')!;
  const log = $('#cloud-model-log')!;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  log.hidden = false;
  log.textContent = '';
  try {
    await apiJson('/api/models/cloud', { method: 'POST', body: { provider, model_id: modelId, api_key: keyInput.value } });
    keyInput.value = '';
    if (!(await waitForRouter(log))) throw new Error('Router failed');
    const label = info.providers.find((p) => p.id === provider)?.label ?? provider;
    const fresh = (await apiJson('/api/models/cloud')) as CloudInfo;
    const registered = ((await apiJson('/api/models')) as Array<{ model_id: string; endpoint: string | null }>).some(
      (m) => m.model_id === modelId && m.endpoint === fresh.router.endpoint,
    );
    if (!registered) {
      await apiJson('/api/models', {
        method: 'POST',
        body: { name: `${label} ${modelId}`, kind: 'openai-compatible', endpoint: fresh.router.endpoint, model_id: modelId },
      });
    }
    modelInput.value = '';
    log.hidden = true;
    showToast('Added', { kind: 'success' });
    await loadCloudModels();
    await fetchModels();
  } catch (err: any) {
    showToast(String(err?.message || err), { kind: 'error' });
  } finally {
    btn.disabled = false;
    render();
  }
}

export function wireCloudModels(): void {
  $('#cloud-model-form')?.addEventListener('submit', (e) => void add(e));
  $('#cloud-provider')?.addEventListener('change', () => void providerChanged());
  watchEffect(() => {
    const box = $('#cloud-models');
    if (box) box.hidden = !state.isOwnerView;
    if (state.isOwnerView) void loadCloudModels();
  });
}
