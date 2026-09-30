<script setup lang="ts">
/**
 * The Owner / Global-admin switches, mounted into <div id="perms-global-toggles">. The
 * audit metadata is visible label text ("(Granted by …)"), not a title attribute — the
 * title tooltip is the matrix's affordance.
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
