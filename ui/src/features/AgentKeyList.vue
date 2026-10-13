<script setup lang="ts">
/**
 * An agent's SSH deploy keys, mounted into <ul id="agent-keys-list">; rows are shaped in
 * renderAgentKeys, including the one-string meta line (ssh command, or path plus note).
 * The private key never reaches the client, so copying the public key is the whole
 * workflow; it uses the .btn-icon copy control (CopyIconButton), paired with Remove.
 */
import { agentKeyRows } from './agent-lists-state.js';
import CopyIconButton from './CopyIconButton.vue';

const props = defineProps<{
  onRemove: (row: { key: unknown }) => void;
}>();

const REMOVE = 'Remove';
</script>

<template>
  <li v-for="r in agentKeyRows" :key="r.name" class="skill-source-row secret-row">
    <div class="skill-info">
      <div class="skill-head">{{ r.name }}</div>
      <span class="skill-desc">{{ r.meta }}</span>
    </div>
    <div class="secret-actions">
      <CopyIconButton :text="r.publicKey" label="Copy public key" /><button
        class="btn btn-danger"
        type="button"
        @click="props.onRemove(r)"
      >{{ REMOVE }}</button>
    </div>
  </li>
</template>
