// Cloud models (owners): which models the router serves, and the router
// install the Add model wizard waits on (AddModel.vue). A provider's key is
// stored by connecting it there; the key goes to the OneCLI vault (server).
import { watchEffect } from 'vue';

import { apiJson, authFetch } from '../core/api.js';
import { state } from '../core/state.js';
import { cloudModelNames, cloudModelProviders } from './cloud-models-state.js';
import { renderModels } from './models.js';

export interface CloudInfo {
  providers: Array<{ id: string; label: string }>;
  router: { installed: boolean; endpoint: string };
  models: string[];
  /** Providers whose key the vault already holds. */
  stored: string[];
  /** Model name → its provider's label. */
  modelProviders?: Record<string, string>;
}

export async function loadCloudModels(): Promise<CloudInfo | null> {
  if (!state.isOwnerView) return null;
  let info: CloudInfo;
  try {
    info = (await apiJson('/api/models/cloud')) as CloudInfo;
  } catch {
    return null;
  }
  cloudModelNames.clear();
  for (const m of info.models) cloudModelNames.add(m);
  cloudModelProviders.clear();
  for (const [m, label] of Object.entries(info.modelProviders ?? {})) if (label) cloudModelProviders.set(m, label);
  // The Models list may have rendered before these were known, hiding them as router backends.
  renderModels();
  return info;
}

// A router install pulls an image and restarts a container; past this the page stops watching.
const ROUTER_INSTALL_WATCH_MS = 10 * 60_000;

/** The router install's state, as /api/router/litellm-install reports it (the install engine's). */
export interface RouterInstallState {
  running: boolean;
  exitCode?: number | null;
  lines?: string[];
  stepIndex?: number;
  stepCount?: number;
  stepLabel?: string | null;
  startedAt?: number | null;
}

/** Wait for the router install a cloud model started; true when it succeeded. `onTick` sees every poll. */
export async function waitForRouter(onTick?: (st: RouterInstallState) => void): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const res = await authFetch('/api/router/litellm-install');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Couldn't read the router install: ${err.error || `HTTP ${res.status}`}`);
    }
    const st = (await res.json()) as RouterInstallState;
    onTick?.(st);
    if (!st.running) return st.exitCode === 0;
    if (Date.now() - started > ROUTER_INSTALL_WATCH_MS) throw new Error('Router still installing after 10 minutes');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export function wireCloudModels(): void {
  watchEffect(() => {
    if (state.isOwnerView) void loadCloudModels();
  });
}
