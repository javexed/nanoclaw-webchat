<script setup lang="ts">
/**
 * The room-create form's "which existing agents" checklist, mounted into
 * <ul id="room-create-existing-agents">. The ticks live in the DOM because the submit
 * handler reads them there (as in AddAgentPicker); rows carry no change listener. The
 * label is agent.name with a '' fallback, and the empty note keys off whether ANY agent
 * exists, so an all-archived list renders an empty <ul> with no note.
 */
import { computed } from 'vue';
import { createAgentAnyExist, createAgentCandidates, createAgentQuery } from './agent-lists-state.js';
import { NO_MATCH, matchesQuery } from '../core/list-filter.js';

const EMPTY = 'No agents yet — create one inline below.';

const rows = computed(() =>
  [...createAgentCandidates.value]
    .sort((a: any, b: any) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map((a: any) => ({ id: a.id, cbId: `room-create-agent-${a.id}`, label: a.name ?? '' })),
);
/** Hidden, not removed: the ticks live in the DOM, so a filtered-out tick still counts. */
const shown = (r: { label: string }) => matchesQuery(createAgentQuery.value, r.label);
const noMatch = computed(() => rows.value.length > 0 && !rows.value.some(shown));
</script>

<template>
  <li v-if="!createAgentAnyExist" class="empty-note">{{ EMPTY }}</li>
  <template v-else>
    <li v-if="noMatch" class="empty-note">{{ NO_MATCH }}</li>
    <li v-for="r in rows" v-show="shown(r)" :key="r.id">
      <input type="checkbox" :value="r.id" :id="r.cbId" />
      <label :for="r.cbId">{{ r.label }}</label>
    </li>
  </template>
</template>
