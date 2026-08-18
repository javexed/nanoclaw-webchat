// ── Audit log viewer state ──────────────────────────────────────────────────
// What the AuditLog island renders. The log itself is append-only on the host;
// nothing here writes, and there is no endpoint that would let it.
import { ref } from 'vue';

export interface AuditRow {
  ts: string;
  seq: number;
  type: string;
  actor?: string;
  action?: string;
  effect?: string;
  reason?: string;
  detail?: Record<string, unknown>;
}

/** Newest first, exactly as the server returned them. */
export const auditRows = ref<AuditRow[]>([]);

/** Distinct types/effects present in the scanned window, for the filter menus. */
export const auditFacets = ref<{ types: string[]; effects: string[] }>({ types: [], effects: [] });

export const auditFilterType = ref('');
export const auditFilterEffect = ref('');

/** More matches exist older than the last row shown. */
export const auditHasMore = ref(false);
/**
 * The server's scan hit its byte budget before reaching the start of the file.
 * Surfaced so the panel can say "older entries exist beyond this window"
 * rather than implying the list is the whole history.
 */
export const auditTruncated = ref(false);
export const auditLoading = ref(false);
export const auditError = ref('');
