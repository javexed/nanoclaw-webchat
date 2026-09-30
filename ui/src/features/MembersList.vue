<script setup lang="ts">
/**
 * The room members list, mounted into <ul id="members-list">.
 */
import { computed } from 'vue';
import { state } from '../core/state.js';
import { members, membersFilter } from './members-list-state.js';

const EMPTY = 'No members match.';

const sorted = computed(() => {
  const all = [...members.value].sort((a: any, b: any) => {
    if (a.identity_type !== b.identity_type) return a.identity_type === 'agent' ? -1 : 1;
    return String(a.identity).localeCompare(String(b.identity));
  });
  const f = membersFilter.value;
  return f ? all.filter((m: any) => `${m.identity} ${m.handle || ''}`.toLowerCase().includes(f)) : all;
});

/** The member's identity, with a " (you)" suffix for the viewer. */
const label = (m: any) => (m.identity === state.myIdentity ? `${m.identity} (you)` : m.identity);
</script>

<template>
  <li v-if="sorted.length === 0" class="member-empty">{{ EMPTY }}</li>
  <template v-else>
    <li v-for="m in sorted" :key="m.identity">
      <span :class="`member-dot ${m.identity_type}`"></span>
      <span class="member-name">{{ label(m) }}</span>
      <span v-if="m.identity_type === 'agent'" class="member-tag">AGENT</span>
      <span v-else-if="m.handle" class="member-handle">@{{ m.handle }}</span>
    </li>
  </template>
</template>
