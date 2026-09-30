<script setup lang="ts">
/**
 * The per-agent-group permission matrix, mounted into <div id="perms-matrix">. The
 * `busy` class togglePerm() adds to a clicked cell is not modelled: nothing re-renders
 * the row until it is removed. `title` is set only when there IS an audit record, so an
 * ungranted cell has no title="".
 */
import { computed } from 'vue';
import { permsAgents, permsDetailUser } from './perms-list-state.js';
import { auditTooltip, findRole } from './perms-audit.js';
import { findMembership } from './perms-user-info.js';

const props = defineProps<{ onToggle: (kind: string, agentGroupId: string, granting: boolean, el: HTMLElement) => void }>();

const EMPTY = 'No agent groups yet.';

const rows = computed(() => {
  const u = permsDetailUser.value;
  if (!u) return [];
  return permsAgents.value.map((a: any) => {
    const adminRole = findRole(u, 'admin', a.id);
    const member = findMembership(u, a.id);
    const name = a.name || a.id;
    return {
      id: a.id,
      name,
      adminRole,
      member,
      adminLabel: `${adminRole ? 'Revoke' : 'Grant'} admin · ${name}`,
      memberLabel: `${member ? 'Revoke' : 'Grant'} member · ${name}`,
    };
  });
});

function toggle(kind: string, agentGroupId: string, granting: boolean, e: MouseEvent) {
  props.onToggle(kind, agentGroupId, granting, e.currentTarget as HTMLElement);
}
</script>

<template>
  <div v-if="rows.length === 0" class="perms-matrix-empty">{{ EMPTY }}</div>
  <template v-else>
    <div v-for="r in rows" :key="r.id" class="perms-matrix-row">
      <span class="perms-group-name" :title="r.id">{{ r.name }}</span>
      <button
        type="button"
        :class="`perms-cell${r.adminRole ? ' on' : ''}`"
        v-bind="r.adminRole ? { title: auditTooltip(r.adminRole) } : {}"
        :aria-label="r.adminLabel"
        @click="toggle('admin', r.id, !r.adminRole, $event)"
      >{{ r.adminRole ? '✓' : '·' }}</button>
      <button
        type="button"
        :class="`perms-cell member-style${r.member ? ' on' : ''}`"
        v-bind="r.member ? { title: auditTooltip(r.member) } : {}"
        :aria-label="r.memberLabel"
        @click="toggle('member', r.id, !r.member, $event)"
      >{{ r.member ? '✓' : '·' }}</button>
    </div>
  </template>
</template>
