<script setup lang="ts">
/**
 * The "wire an existing agent" checklist, mounted into <ul id="room-add-agent-list">. The
 * checked state lives in the DOM: updateAddAgentSubmitLabel() and the submit handler read
 * input:checked, and a missed reader would fail silently (a submit that wires nothing).
 */
import { computed } from 'vue';
import { addAgentCandidates, addAgentQuery } from './agent-lists-state.js';
import { NO_MATCH, matchesQuery } from '../core/list-filter.js';

const props = defineProps<{ onToggle: () => void }>();

const EMPTY = 'No unwired agents — switch to "New" to create one.';

const rows = computed(() =>
  [...addAgentCandidates.value]
    .sort((a: any, b: any) => (a.name || a.id).localeCompare(b.name || b.id))
    .map((a: any) => ({
      id: a.id,
      cbId: `room-add-agent-${a.id}`,
      name: a.name || a.id,
      sub: a.folder || a.id,
    })),
);
/** Hidden, not removed: the ticks live in the DOM, so a filtered-out tick still counts. */
const shown = (r: { name: string; sub: string }) => matchesQuery(addAgentQuery.value, r.name, r.sub);
const noMatch = computed(() => rows.value.length > 0 && !rows.value.some(shown));
</script>

<template>
  <li v-if="rows.length === 0" class="empty-note">{{ EMPTY }}</li>
  <template v-else>
    <li v-if="noMatch" class="empty-note">{{ NO_MATCH }}</li>
    <li v-for="r in rows" v-show="shown(r)" :key="r.id" class="room-add-agent-row">
      <input type="checkbox" :value="r.id" :id="r.cbId" @change="props.onToggle()" />
      <label :for="r.cbId" class="room-add-agent-label">
        <span class="room-add-agent-name">{{ r.name }}</span
        ><span class="room-add-agent-sub">{{ r.sub }}</span>
      </label>
    </li>
  </template>
</template>
