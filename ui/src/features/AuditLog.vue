<script setup lang="ts">
/**
 * The audit log viewer — read-only, in Admin → Maintenance.
 *
 * The log has existed since the audit work landed, but the only way to read it
 * was tailing logs/audit.jsonl on the host. A security record nobody can read
 * during an incident is a record that only pays off if someone happens to have
 * shell access at the time.
 *
 * Deliberately read-only: no delete, no edit, no clear. An audit trail an
 * operator can rewrite from the UI is not an audit trail, so there is no
 * endpoint to call even if a control existed.
 */
import { computed } from 'vue';
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

const props = defineProps<{
  onFilter: () => void;
  onOlder: () => void;
}>();

const EMPTY = 'No audit events match.';
const OLDER = 'Load older';
const TRUNCATED = 'Older entries exist beyond the scanned window.';

/** Local time — an operator correlating with other logs is reading this clock. */
function when(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/**
 * The identifiers carried with the event. Payloads are deliberately never
 * recorded (see src/audit.ts), so this is always ids and outcomes — never
 * message text or secrets.
 */
function detailOf(row: { detail?: Record<string, unknown>; reason?: string }): string {
  const parts: string[] = [];
  if (row.reason) parts.push(row.reason);
  for (const [k, v] of Object.entries(row.detail ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(' · ');
}

const rows = computed(() =>
  auditRows.value.map((r) => ({
    key: `${r.ts}:${r.seq}`,
    when: when(r.ts),
    type: r.type,
    actor: r.actor || '—',
    action: r.action || '',
    effect: r.effect || '',
    // Refusals and failures are the ones worth spotting in a wall of allows.
    warn: r.effect === 'deny' || r.effect === 'failed',
    detail: detailOf(r),
  })),
);
</script>

<template>
  <div class="audit-log">
    <div class="audit-filters">
      <select v-model="auditFilterType" aria-label="Filter by event type" @change="props.onFilter()">
        <option value="">All types</option>
        <option v-for="t in auditFacets.types" :key="t" :value="t">{{ t }}</option>
      </select>
      <select v-model="auditFilterEffect" aria-label="Filter by outcome" @change="props.onFilter()">
        <option value="">All outcomes</option>
        <option v-for="e in auditFacets.effects" :key="e" :value="e">{{ e }}</option>
      </select>
    </div>

    <p v-if="auditError" class="cred-hint err">{{ auditError }}</p>
    <p v-else-if="!rows.length && !auditLoading" class="cred-hint">{{ EMPTY }}</p>

    <ul class="audit-rows">
      <li v-for="r in rows" :key="r.key" :class="{ warn: r.warn }">
        <div class="audit-row-head">
          <span class="audit-when">{{ r.when }}</span>
          <span class="audit-type">{{ r.type }}</span>
          <span v-if="r.action" class="audit-action">{{ r.action }}</span>
          <span v-if="r.effect" class="audit-effect" :class="{ warn: r.warn }">{{ r.effect }}</span>
        </div>
        <div class="audit-row-meta">
          <span class="audit-actor">{{ r.actor }}</span>
          <span v-if="r.detail" class="audit-detail">{{ r.detail }}</span>
        </div>
      </li>
    </ul>

    <div class="audit-more">
      <button v-if="auditHasMore" class="btn btn-secondary" type="button" :disabled="auditLoading" @click="props.onOlder()">
        {{ OLDER }}
      </button>
      <span v-else-if="auditTruncated" class="cred-hint">{{ TRUNCATED }}</span>
    </div>
  </div>
</template>
