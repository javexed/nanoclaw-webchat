// ── Fit context to GPU: the prompt after adding Ollama models ───────────────
// The setting is off by default, so adding a model asks instead (owners only),
// and only when the server says fitting could give it a larger window:
// fitting loads trial copies of the model on its host's GPU for a few minutes.
import { apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { showToast } from '../core/toast.js';
import { showConfirmModal } from './modals.js';
import { fitContext } from './ollama-cards-state.js';

interface AddedModel {
  id: string;
  kind: string;
  model_id: string;
  endpoint?: string | null;
}

function hostOf(endpoint: string | null | undefined): string {
  try {
    return new URL(endpoint ?? '').hostname;
  } catch {
    return 'its host';
  }
}

interface Worth {
  id: string;
  served: number;
  maxContext: number | null;
}

const k = (n: number): string => `${Math.round(n / 1024)}k`;

/** After an add: offer to fit the new Ollama models that could get a larger window. True when fits started. */
export async function offerFitContext(added: AddedModel[]): Promise<boolean> {
  const ollama = added.filter((m) => m && m.kind === 'ollama');
  // On: the server fits them already. Not an owner: not theirs to start.
  if (!ollama.length || fitContext.value === true || !state.isOwnerView) return false;
  let worth: Worth[];
  try {
    const out: { models?: Worth[] } = await apiJson('/api/models/fit-context/check', {
      method: 'POST',
      body: { ids: ollama.map((m) => m.id) },
    });
    worth = out.models ?? [];
  } catch {
    return false;
  }
  const picked = ollama.filter((m) => worth.some((w) => w.id === m.id));
  if (!picked.length) return false;
  const names = picked
    .map((m) => {
      const w = worth.find((x) => x.id === m.id)!;
      return `${m.model_id} (${k(w.served)}${w.maxContext ? ` of ${k(w.maxContext)}` : ''})`;
    })
    .join(', ');
  const hosts = [...new Set(picked.map((m) => hostOf(m.endpoint)))].join(', ');
  const yes = await showConfirmModal({
    title: 'Fit context to GPU?',
    body: `${names} on ${hosts}: finds the largest context that stays on the GPU. Loads trial copies there for a few minutes.`,
    confirmLabel: 'Fit',
    cancelLabel: 'Not now',
  });
  if (!yes) return false;
  try {
    await apiJson('/api/models/fit-context/start', { method: 'POST', body: { ids: picked.map((m) => m.id) } });
    return true;
  } catch (err: any) {
    showToast('Could not start: ' + (err?.message || err), { kind: 'error' });
    return false;
  }
}
