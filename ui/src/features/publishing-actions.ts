// ── Admin → Publishing: writes ──────────────────────────────────────────────
// Each answer is the whole fresh view (status lines included), so the panel
// re-renders from what the server now holds.
import { apiJson } from '../core/api.js';
import { publishingView, type PublishingView } from './publishing-state.js';

/** PUT a route's settings or switch; the answer is the whole fresh view. Throws the server's refusal. */
export async function saveRoute(kind: 'tailnet' | 'cloudflare', body: Record<string, unknown>): Promise<void> {
  publishingView.value = (await apiJson(`/api/publishing/${kind}`, { method: 'PUT', body })) as PublishingView;
}

/** PUT the Workloads or Confined builds switch; the answer is the whole fresh view. */
export async function saveWorkloads(body: { on?: boolean; confinedBuilds?: boolean }): Promise<void> {
  publishingView.value = (await apiJson('/api/publishing/workloads', { method: 'PUT', body })) as PublishingView;
}

/** Read the view again (a status still being checked). */
export async function refreshPublishing(): Promise<void> {
  publishingView.value = (await apiJson('/api/publishing')) as PublishingView;
}

/** Hand a credential to the vault. Throws the server's refusal. */
export async function connectRoute(kind: 'tailnet' | 'cloudflare', body: Record<string, string>): Promise<void> {
  publishingView.value = (await apiJson(`/api/publishing/${kind}/connect`, { method: 'POST', body })) as PublishingView;
}
