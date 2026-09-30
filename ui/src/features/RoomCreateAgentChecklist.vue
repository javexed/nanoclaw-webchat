<script setup lang="ts">
/**
 * The room-create form's "which existing agents" checklist, mounted into
 * <ul id="room-create-existing-agents">. The ticks live in the DOM because the submit
 * handler reads them there (as in AddAgentPicker); rows carry no change listener. The
 * label is agent.name with a '' fallback, and the empty note keys off whether ANY agent
 * exists, so an all-archived list renders an empty <ul> with no note.
 */
import { computed } from 'vue';
import { createAgentAnyExist, createAgentCandidates } from './agent-lists-state.js';

const EMPTY = 'No agents yet — create one inline below.';

const rows = computed(() =>
  [...createAgentCandidates.value]
    .sort((a: any, b: any) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map((a: any) => ({ id: a.id, cbId: `room-create-agent-${a.id}`, label: a.name ?? '' })),
);
</script>

<template>
  <li v-if="!createAgentAnyExist" class="empty-note">{{ EMPTY }}</li>
  <template v-else>
    <li v-for="r in rows" :key="r.id">
      <input type="checkbox" :value="r.id" :id="r.cbId" />
      <label :for="r.cbId">{{ r.label }}</label>
    </li>
  </template>
</template>
