<script setup lang="ts">
/**
 * The room-create form's "which existing agents" checklist — seventeenth
 * island.
 *
 * Mounted into <ul id="room-create-existing-agents">, exclusively owned by this
 * module.
 *
 * Same contract as AddAgentPicker: the ticks live in the DOM because the submit
 * handler reads them with querySelectorAll. These rows carry no change
 * listener at all — the imperative version attached none either, so this island
 * adds no listeners to the boot set.
 *
 * Two things copied rather than harmonised, both because changing them would be
 * a behaviour change this phase does not make:
 *   - the label is agent.name with a '' fallback, not `name || id`
 *   - the empty note keys off whether ANY agent exists, not off the filtered
 *     list, so every-agent-archived renders an empty <ul> with no note
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
