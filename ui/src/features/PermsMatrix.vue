<script setup lang="ts">
/**
 * The per-agent-group permission matrix — thirteenth island.
 *
 * Mounted into <div id="perms-matrix">, exclusively owned by this module.
 *
 * Two cells per group, admin and member, each a tap-to-toggle button. The
 * `busy` class the click handler adds is NOT modelled here: togglePerm() adds
 * it to the clicked element and removes it when the request settles, and it
 * survives because the row is not re-rendered in between — refreshPermissions()
 * only runs after the class is already off again. Modelling it as state would
 * mean threading a per-cell pending flag for a class nothing reads.
 *
 * `title` is set only when there IS an audit record, matching the imperative
 * version's `if (adminRole) adminBtn.title = …`. An unconditional :title would
 * emit title="" on every ungranted cell, which is the same class of difference
 * as the :class="{active:false}" one from the first island.
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
