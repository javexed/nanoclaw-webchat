// ── Ollama host cards ───────────────────────────────────────────────────────
// One collapsible card per configured Ollama host: its model list, a pull box,
// and pull progress. The card chrome is built here; the model list is filled by
// loadOllamaHostModels (models.ts) and the progress line by renderOllamaPulls
// (installers.ts).
//
// Out of legacy.js as a unit because those three write into the SAME card
// subtree, so none of them can become an island independently — the card
// builder would keep destroying and rebuilding the elements the others own.
// This move puts the whole cluster in one TS module so the conversion that
// follows is a single island owning #ollama-host-cards.
//
// Converted in 4.2r: the card chrome, its model list and its pull line are one
// island now (OllamaHostCards.vue). The accordion's localStorage seam moved to
// ollama-cards-state.ts, keeping the same `serverCardOpen:<host>` keys so an
// operator's expanded cards survive the conversion.
import { $ } from '../core/dom.js';
import { allModels } from './model-list-state.js';
import { showConfirmModal } from './modals.js';
import { showToast } from '../core/toast.js';
import { routingClassifierModel } from './routing-state.js';
import { authFetch } from '../core/api.js';
import { probeRoutingAvailability } from './routing.js';
import { loadOllamaHostModels } from './models.js';
import { cancelOllamaPull, pollOllamaPulls, previewOllamaPull, startOllamaPull } from './installers.js';
import { createApp } from 'vue';
import OllamaHostCards from './OllamaHostCards.vue';
import { hostModels, hosts as hostList, syncOpenCards } from './ollama-cards-state.js';

let cardsApp: ReturnType<typeof createApp> | null = null;

function mountOllamaHostCards(): void {
  if (cardsApp) return;
  const host = $('#ollama-host-cards');
  if (!host) return;
  cardsApp = createApp(OllamaHostCards, {
    onPull: (h: string, model: string, input: HTMLInputElement, btn: HTMLElement) =>
      startOllamaPull(h, model, input, btn),
    onRemove: (h: string, model: string) => void removeHostModel(h, model),
    onCancel: (h: string, model: string) => void cancelOllamaPull(h, model),
    onPreview: (h: string, model: string) => previewOllamaPull(h, model),
  });
  cardsApp.mount(host);
}

/** A host card carries its summary span so the model list can update the count. */
export interface OllamaCard extends HTMLElement {
  _summary?: HTMLElement;
}

// No deps seam: this module needs nothing from legacy. It had exactly one
// entry — a read of legacy's routingClassifierModel — and that value moved to
// features/routing-state.ts, so the bridge went with it. First of the 23 to go.

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
    const res = await authFetch('/api/ollama/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ host, model }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error || res.statusText);
    showToast(`Removed ${model}`, { kind: 'success' });
    void loadOllamaHostModels(host);
  } catch (err: any) {
    showToast('Remove failed: ' + (err?.message || err), { kind: 'error' });
  }
}
