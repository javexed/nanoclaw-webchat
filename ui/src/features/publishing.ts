// ── Admin → Publishing ──────────────────────────────────────────────────────
// The tailnet and Cloudflare publishing routes: a switch, settings, Connect
// (the credential goes straight to the OneCLI vault and is never shown again)
// and a status line each. Owner only: hidden for everyone else, and the GET
// answers 403 to them anyway.
import { createApp } from 'vue';
import { apiJson } from '../core/api.js';
import { $ } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { state } from '../core/state.js';
import PublishingPanel from './PublishingPanel.vue';
import { publishingView, type PublishingView } from './publishing-state.js';

let panelApp: ReturnType<typeof createApp> | null = null;

export async function renderPublishingSettings(): Promise<void> {
  const section = $('#settings-publishing');
  if (!section) return;
  section.hidden = !state.isOwnerView;
  if (!state.isOwnerView) return;
  let view: PublishingView | null = null;
  try {
    view = (await apiJson('/api/publishing')) as PublishingView;
  } catch {
    view = null;
  }
  if (!view?.tailnet || !view.cloudflare) {
    section.hidden = true; // 403, or not this server's shape
    return;
  }
  publishingView.value = view;
  panelApp ??= mountIsland('#publishing-panel', () => createApp(PublishingPanel));
}
