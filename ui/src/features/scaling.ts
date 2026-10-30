// Admin → Scaling: owners and global admins (the API is guarded `globalAdmin`;
// a scoped admin's 403 keeps the section hidden).
import { createApp, type App } from 'vue';

import { apiJson } from '../core/api.js';
import { $ } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { isAdminView, state } from '../core/state.js';
import MachinesPanel from './MachinesPanel.vue';

let app: App | null = null;
let panel: { load: () => Promise<void> } | null = null;

export async function renderScalingSettings(): Promise<void> {
  const section = $('#settings-scaling');
  if (!section) return;
  if (!state.isOwnerView && !isAdminView.value) {
    section.hidden = true;
    return;
  }
  try {
    await apiJson('/api/scaling/machines');
  } catch {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (app) {
    void panel?.load();
    return;
  }
  app = mountIsland('#machines-panel', () => createApp(MachinesPanel));
  panel = (app?._instance?.exposed as typeof panel) ?? null;
}
