// ── Add model ──────────────────────────────────────────────────────────────
// Mounts the wizard fresh each time the panel opens (AddModel.vue), and hands
// a finished add to the same steps the probe's add takes.
import { createApp, type App } from 'vue';

import { $ } from '../core/dom.js';
import { showToast } from '../core/toast.js';
import AddModel from './AddModel.vue';
import { offerFitContext } from './fit-context-offer.js';
import { closeModelDetail, fetchModels, maybeAssignAfterPickerAdd } from './models.js';

let app: App | null = null;

function showCustom(show: boolean) {
  const box = $('#model-add-custom');
  if (box) box.hidden = !show;
}

async function done(models: any[]) {
  await offerFitContext(models);
  await fetchModels();
  closeModelDetail();
  showToast('Added', { kind: 'success' });
  await maybeAssignAfterPickerAdd(models.map((m) => m.id));
}

export function openAddModel(): void {
  const host = $('#model-add');
  if (!host) return;
  app?.unmount();
  showCustom(false);
  app = createApp(AddModel, { onDone: (m: any[]) => void done(m), onCustom: showCustom });
  app.mount(host);
}
