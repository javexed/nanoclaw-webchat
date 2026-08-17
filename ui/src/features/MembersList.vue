<script setup lang="ts">
/**
 * The room members list — third island.
 *
 * Mounted into <ul id="members-list">, exclusively owned by this module.
 *
 * Vue rendering rules established by the first two islands and applied here:
 *   - text that must match textContent exactly is BOUND, never written as
 *     template text (template text carries the surrounding newlines)
 *   - no comments in the template; Vue renders them as DOM comment nodes
 *   - v-bind an object for conditional attributes; :class emits class=""
 * This island needs none of the class exceptions — every class here is static.
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

/** Matches the imperative label exactly, including the " (you)" suffix. */
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
