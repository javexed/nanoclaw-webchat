// ── Admin → Publishing: state ───────────────────────────────────────────────
// What GET /api/publishing returns (modules/workloads/publishing-settings.ts)
// and the small decisions PublishingPanel.vue renders from.
import { shallowRef } from 'vue';

export interface StatusLine {
  text: string;
  ok: boolean;
  needsConnect: boolean;
  detail: string;
  warnings: Array<{ text: string; detail: string }>;
}

export interface PublishingView {
  gate: { text: string; detail: string } | null;
  tailnet: { on: boolean; domain: string; status: StatusLine };
  cloudflare: {
    on: boolean;
    domain: string;
    accountId: string;
    zoneId: string;
    teamDomain: string;
    status: StatusLine;
  };
}

export type CloudflareFields = Pick<PublishingView['cloudflare'], 'domain' | 'accountId' | 'zoneId' | 'teamDomain'>;

export const publishingView = shallowRef<PublishingView | null>(null);

/** The Connect button: Reconnect once the credential is in place. */
export function connectLabel(status: Pick<StatusLine, 'needsConnect'>): string {
  return status.needsConnect ? 'Connect…' : 'Reconnect…';
}

/** The fields that differ from what is saved, trimmed; empty when nothing changed. */
export function changedFields(saved: CloudflareFields, typed: CloudflareFields): Partial<CloudflareFields> {
  const out: Partial<CloudflareFields> = {};
  for (const k of ['domain', 'accountId', 'zoneId', 'teamDomain'] as const) {
    const v = typed[k].trim();
    if (v !== saved[k]) out[k] = v;
  }
  return out;
}

/** A refusal's field, as the server names it, or '' for one shown under the form. */
export function errorField(err: unknown): string {
  const f = (err as { body?: { field?: unknown } } | null)?.body?.field;
  return typeof f === 'string' ? f : '';
}
