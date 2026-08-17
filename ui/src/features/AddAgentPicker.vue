<script setup lang="ts">
/**
 * The "wire an existing agent" checklist — sixteenth island.
 *
 * Mounted into <ul id="room-add-agent-list">, exclusively owned by this module.
 *
 * The checkboxes stay REAL inputs whose checked state lives in the DOM, exactly
 * as before: updateAddAgentSubmitLabel() and the submit handler both read them
 * with querySelectorAll('input:checked'). Modelling the selection as a ref
 * would mean changing those two readers as well, and the failure mode if one
 * were missed is silent — a submit that wires nothing. Vue only re-renders this
 * list when the candidate refs change, which is the same moment the imperative
 * version rebuilt it and dropped the ticks.
 *
 * #room-add-agent-existing-submit is outside the mount point and stays
 * imperative.
 */
import { computed } from 'vue';
import { addAgentCandidates } from './agent-lists-state.js';

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
</script>

<template>
  <li v-if="rows.length === 0" class="empty-note">{{ EMPTY }}</li>
  <template v-else>
    <li v-for="r in rows" :key="r.id" class="room-add-agent-row">
      <input type="checkbox" :value="r.id" :id="r.cbId" @change="props.onToggle()" />
      <label :for="r.cbId" class="room-add-agent-label">
        <span class="room-add-agent-name">{{ r.name }}</span
        ><span class="room-add-agent-sub">{{ r.sub }}</span>
      </label>
    </li>
  </template>
</template>
