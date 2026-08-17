<script setup lang="ts">
/**
 * The Owner / Global-admin switches — twelfth island.
 *
 * Mounted into <div id="perms-global-toggles">, exclusively owned by this
 * module.
 *
 * This one absorbs a legacy function rather than calling it. buildToggleRow()
 * lived in legacy.js and built these rows imperatively; it was used by nothing
 * except renderPermsDetail, and it is pure markup plus one click handler. A
 * component that received DOM nodes from a legacy builder would be a component
 * in name only — so the markup moved into this template and the legacy function
 * is deleted in the same commit, along with its dep entry.
 *
 * The audit metadata is deliberately rendered twice over: the label carries
 * "(Granted by …)" as visible text, exactly as the imperative row did. It is
 * not a title attribute here — that is the matrix, which is a different island
 * and a different affordance.
 */
import { computed } from 'vue';
import { permsDetailUser } from './perms-list-state.js';
import { auditTooltip, findRole } from './perms-audit.js';

const props = defineProps<{ onToggle: (kind: string, granting: boolean) => void }>();

/** [label, prefix, role kind] — the two global roles, in display order. */
const ROWS: Array<[string, string, string]> = [
  ['Owner', '👑 ', 'owner'],
  ['Global admin', '', 'admin'],
];

const rows = computed(() =>
  ROWS.map(([label, prefix, kind]) => {
    const audit = permsDetailUser.value ? findRole(permsDetailUser.value, kind, null) : null;
    return {
      kind,
      label,
      text: `${prefix}${label}`,
      audit,
      meta: audit ? `(${auditTooltip(audit)})` : '',
    };
  }),
);
</script>

<template>
  <div v-for="r in rows" :key="r.kind" class="perms-toggle-row">
    <span class="perms-toggle-label"
      >{{ r.text }}<span v-if="r.audit" class="perms-toggle-meta">{{ r.meta }}</span></span
    >
    <button
      type="button"
      :class="`perms-switch${r.audit ? ' on' : ''}`"
      role="switch"
      :aria-checked="r.audit ? 'true' : 'false'"
      :aria-label="r.label"
      @click="props.onToggle(r.kind, !r.audit)"
    ></button>
  </div>
</template>
