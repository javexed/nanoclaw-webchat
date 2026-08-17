<script setup lang="ts">
/**
 * An agent's tool secrets — eighteenth island.
 *
 * Mounted into <ul id="agent-secrets-list">, exclusively owned by this module.
 *
 * The imperative version had a local row() helper and called it twice: once per
 * shared secret, then once per member secret with `personal` set. Both appended
 * to the same <ul>, so the DOM was always one flat list — the rows arrive here
 * already flattened and the component does not know there were two loops.
 *
 * No empty state, deliberately. The original rendered nothing when both loops
 * were empty, and adding a note here would be new UI rather than a conversion.
 */
import { agentSecretRows } from './agent-lists-state.js';

const props = defineProps<{ onRemove: (row: { scope: unknown; sec: unknown }) => void }>();

const REMOVE = 'Remove';
</script>

<template>
  <li v-for="r in agentSecretRows" :key="r.key" class="skill-source-row secret-row">
    <div class="skill-info">
      <div class="skill-head">
        <span>{{ r.host }}</span
        ><span :class="`skill-badge secret-scope${r.personal ? ' skill-badge-user' : ''}`">{{
          r.personal ? 'personal' : 'shared'
        }}</span>
      </div>
      <span v-if="r.personal" class="skill-desc">{{ r.ownerLabel }}</span>
    </div>
    <button class="btn btn-danger" type="button" @click="props.onRemove(r)">{{ REMOVE }}</button>
  </li>
</template>
