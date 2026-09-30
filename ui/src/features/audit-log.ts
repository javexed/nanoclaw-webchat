// ── Audit log viewer wiring ─────────────────────────────────────────────────
// Mounts the AuditLog island and feeds it from /api/webchat/audit-log.
import { createApp } from 'vue';

import { $ } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
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
  app ??= mountIsland('#audit-log-view', () =>
    createApp(AuditLog, {
      onFilter: () => void loadAuditLog(),
      onOlder: () => void loadAuditLog({ older: true }),
    }),
  );
}

function query(beforeTs?: string): string {
  const p = new URLSearchParams({ limit: '50' });
  if (auditFilterType.value) p.set('type', auditFilterType.value);
  if (auditFilterEffect.value) p.set('effect', auditFilterEffect.value);
  if (beforeTs) p.set('beforeTs', beforeTs);
  return p.toString();
}

/**
 * Load the newest page, or append the next older one. Self-hides on 403 like
 * every Admin block; any other failure shows a message rather than an empty
 * list, so a security log never reads "nothing happened" when it could not tell.
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
