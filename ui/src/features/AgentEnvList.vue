<script setup lang="ts">
/**
 * An agent's environment variables, mounted into <div id="agent-env-list">. NAMES only:
 * the server never sends values. Delete disables its button while in flight and re-enables
 * on failure; keyed by name because that is what the endpoint takes.
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
