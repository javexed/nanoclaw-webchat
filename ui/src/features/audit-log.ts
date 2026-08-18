// ── Audit log viewer wiring ─────────────────────────────────────────────────
// Mounts the AuditLog island and feeds it from /api/webchat/audit-log.
import { createApp } from 'vue';

import { $ } from '../core/dom.js';
import { authFetch } from '../core/api.js';
import AuditLog from './AuditLog.vue';
import {
  auditError,
  auditFacets,
  auditFilterEffect,
  auditFilterType,
  auditHasMore,
  auditLoading,
  auditRows,
  auditTruncated,
} from './audit-log-state.js';

let app: ReturnType<typeof createApp> | null = null;

function mount(): void {
  if (app) return;
  const host = $('#audit-log-view');
  if (!host) return;
  app = createApp(AuditLog, {
    onFilter: () => void loadAuditLog(),
    onOlder: () => void loadAuditLog({ older: true }),
  });
  app.mount(host);
}

function query(beforeTs?: string): string {
  const p = new URLSearchParams({ limit: '50' });
  if (auditFilterType.value) p.set('type', auditFilterType.value);
  if (auditFilterEffect.value) p.set('effect', auditFilterEffect.value);
  if (beforeTs) p.set('beforeTs', beforeTs);
  return p.toString();
}

/**
 * Load the newest page, or append the next older one.
 *
 * Self-hiding on 403, the same contract every block on the Admin page uses:
 * a non-owner gets no panel rather than an error. Any other failure shows a
 * message instead of an empty list, so "nothing happened" and "we could not
 * tell you what happened" stay distinguishable — which for a security log is
 * the whole point.
 */
export async function loadAuditLog(opts: { older?: boolean } = {}): Promise<void> {
  const section = $('#settings-audit');
  mount();
  auditLoading.value = true;
  auditError.value = '';
  try {
    const cursor = opts.older ? auditRows.value[auditRows.value.length - 1]?.ts : undefined;
    const res = await authFetch('/api/webchat/audit-log?' + query(cursor));
    if (res.status === 403) {
      if (section) section.hidden = true;
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    auditRows.value = opts.older ? [...auditRows.value, ...(body.events || [])] : body.events || [];
    auditFacets.value = body.facets || { types: [], effects: [] };
    auditHasMore.value = !!body.hasMore;
    auditTruncated.value = !!body.truncated;
  } catch (err: any) {
    auditError.value = 'Could not read the audit log: ' + (err?.message || err);
  } finally {
    auditLoading.value = false;
  }
}
