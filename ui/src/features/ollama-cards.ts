// ── Ollama host cards ───────────────────────────────────────────────────────
// One collapsible card per configured Ollama host: its model list, a pull box,
// and pull progress, rendered by one island (OllamaHostCards.vue). The model
// list is filled by loadOllamaHostModels (models.ts) and the progress line by
// renderOllamaPulls (installers.ts), via ollama-cards-state.ts.
import { $ } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { allModels } from './model-list-state.js';
import { showConfirmModal } from './modals.js';
import { showToast } from '../core/toast.js';
import { routingClassifierModel } from './routing-state.js';
import { apiJson, authFetch } from '../core/api.js';
import { probeRoutingAvailability } from './routing.js';
import { fetchModels, loadOllamaHostModels } from './models.js';
import { cancelOllamaPull, pollOllamaPulls, previewOllamaPull, startOllamaPull } from './installers.js';
import { createApp } from 'vue';
import OllamaHostCards from './OllamaHostCards.vue';
import {
  fitContext,
  fitJobs,
  hostHealth,
  hostModels,
  hosts as hostList,
  syncOpenCards,
} from './ollama-cards-state.js';

let cardsApp: ReturnType<typeof createApp> | null = null;

function mountOllamaHostCards(): void {
  cardsApp ??= mountIsland('#ollama-host-cards', () =>
    createApp(OllamaHostCards, {
      onPull: (h: string, model: string, input: HTMLInputElement, btn: HTMLElement) =>
        startOllamaPull(h, model, input, btn),
      onRemove: (h: string, model: string) => void removeHostModel(h, model),
      onCancel: (h: string, model: string) => void cancelOllamaPull(h, model),
      onPreview: (h: string, model: string) => previewOllamaPull(h, model),
      onFitContext: (on: boolean) => void setFitContext(on),
    }),
  );
}

/** A host card carries its summary span so the model list can update the count. */
export interface OllamaCard extends HTMLElement {
  _summary?: HTMLElement;
}

export function ollamaCardId(host: string): string {
  return 'ollama-card-' + host.replace(/[^a-z0-9]/gi, '-');
}

export async function loadOllamaHosts() {
  const wrap = $('#ollama-hosts');
  if (!wrap) return;
  // Learn the routing classifier id before host models render so it sections
  // into "System" rather than flashing as a selectable "+".
  if (routingClassifierModel.value === null) await probeRoutingAvailability();
  try {
    const hostsRes = await authFetch('/api/ollama/hosts');
    if (!hostsRes.ok) {
      wrap.hidden = true; // non-owner
      return;
    }
    const { hosts } = await hostsRes.json();
    wrap.hidden = hosts.length === 0;
    if (wrap.hidden) return;
    // Seed the accordion from storage BEFORE the island renders, so a card
    // that was left open does not flash shut on the first paint.
    syncOpenCards(hosts);
    hostList.value = hosts;
    for (const host of hosts) hostModels.value[host] = { phase: 'loading', selectable: [], system: [], error: '' };
    mountOllamaHostCards();
    for (const host of hosts) loadOllamaHostModels(host);
    pollOllamaPulls(); // pick up any pull still running from a previous visit
    void loadModelHosts();
  } catch (err) {
    console.error('Failed to load servers:', err);
    wrap.hidden = true;
  }
}

/**
 * Remove a model's files from an Ollama host — the undo of a pull, so it gets
 * the same weight of ceremony: a destructive confirm carrying what the delete
 * MEANS, not just what it does. A model still registered in webchat keeps its
 * registry row (which then shows as not-pulled) — that is stated in the
 * confirm rather than silently breaking an agent.
 */
async function removeHostModel(host: string, model: string): Promise<void> {
  const registered = allModels.value.some(
    (m: any) => m.kind === 'ollama' && m.model_id === model && (m.endpoint || '').startsWith(host),
  );
  const bodyEl = document.createElement('div');
  const line = (text: string) => {
    const d = document.createElement('div');
    d.className = 'cred-hint';
    d.textContent = text;
    bodyEl.appendChild(d);
  };
  line(`Deletes the model files from ${host} — frees the disk space, and re-downloading means a full pull.`);
  if (registered)
    line('⚠ This model is registered in webchat — agents assigned to it will fail until it is pulled again or they are reassigned.');
  const ok = await showConfirmModal({
    title: `Remove ${model} from this server?`,
    body: bodyEl,
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!ok) return;
  try {
    await apiJson('/api/ollama/delete', { method: 'POST', headers: { 'X-Webchat-CSRF': '1' }, body: { host, model } });
    showToast(`Removed ${model}`, { kind: 'success' });
    void loadOllamaHostModels(host);
  } catch (err: any) {
    showToast('Remove failed: ' + (err?.message || err), { kind: 'error' });
  }
}

let hostsPoller: ReturnType<typeof setTimeout> | null = null;
/** Fits seen running, so each one's finish refreshes the lists once. */
const fitsRunning = new Set<string>();

/**
 * Host health, the GPU fits and the fit setting. Polled while a fit runs; a
 * finished fit may have registered a variant, so the model list is re-read.
 */
export async function loadModelHosts(): Promise<void> {
  if (hostsPoller) clearTimeout(hostsPoller);
  hostsPoller = null;
  try {
    const body = await apiJson('/api/models/hosts');
    hostHealth.value = body.health || {};
    fitJobs.value = body.fits || [];
    fitContext.value = !!body.fitContext;
  } catch {
    return;
  }
  const running = fitJobs.value.filter((j) => j.status === 'queued' || j.status === 'fitting');
  const finished = [...fitsRunning].filter((k) => !running.some((j) => j.host + '\u0000' + j.model === k));
  for (const j of running) fitsRunning.add(j.host + '\u0000' + j.model);
  for (const k of finished) fitsRunning.delete(k);
  if (finished.length) {
    void fetchModels();
    return; // fetchModels reloads the hosts, which reads this again
  }
  if (running.length) hostsPoller = setTimeout(() => void loadModelHosts(), 2000);
}

async function setFitContext(on: boolean): Promise<void> {
  const prev = fitContext.value;
  fitContext.value = on;
  try {
    await apiJson('/api/models/fit-context', { method: 'PUT', body: { enabled: on } });
  } catch (err: any) {
    fitContext.value = prev;
    showToast('Could not save: ' + (err?.message || err), { kind: 'error' });
  }
}
