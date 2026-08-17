<script setup lang="ts">
/**
 * An agent's environment variables — fiftieth island.
 *
 * Mounted into <div id="agent-env-list">, exclusively owned by this module.
 * #agent-env-count and the save control are outside it and stay imperative.
 *
 * NAMES only. The server never sends values, and the row shows `$NAME` — the
 * point of the panel is which variables exist, not what they hold.
 *
 * The delete button disables itself while its request is in flight and
 * re-enables on failure, exactly as before; on success the list re-renders and
 * the row is gone. Keyed by name because that is what the endpoint takes.
 */
import { agentEnvDeleting, agentEnvNames } from './agent-lists-state.js';

const props = defineProps<{ onRemove: (name: string) => void }>();

const REMOVE = 'Remove';
</script>

<template>
  <div v-for="name in agentEnvNames" :key="name" class="secret-row">
    <code>${{ name }}</code
    ><button
      class="btn btn-ghost"
      type="button"
      :disabled="agentEnvDeleting.has(name) || undefined"
      @click="props.onRemove(name)"
    >{{ REMOVE }}</button>
  </div>
</template>
