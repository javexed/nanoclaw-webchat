<script setup lang="ts">
/**
 * An agent's SSH deploy keys, mounted into <ul id="agent-keys-list">; rows are shaped in
 * renderAgentKeys, including the one-string meta line (ssh command, or path plus note).
 * The private key never reaches the client, so "Copy public key" is the whole workflow and
 * takes the prominent button.
 */
import { agentKeyRows } from './agent-lists-state.js';

const props = defineProps<{
  onCopy: (row: { publicKey: string }) => void;
  onRemove: (row: { key: unknown }) => void;
}>();

const COPY = 'Copy public key';
const REMOVE = 'Remove';
</script>

<template>
  <li v-for="r in agentKeyRows" :key="r.name" class="skill-source-row secret-row">
    <div class="skill-info">
      <div class="skill-head">{{ r.name }}</div>
      <span class="skill-desc">{{ r.meta }}</span>
    </div>
    <div class="secret-actions">
      <button class="btn btn-secondary" type="button" @click="props.onCopy(r)">{{ COPY }}</button
      ><button class="btn btn-danger" type="button" @click="props.onRemove(r)">{{ REMOVE }}</button>
    </div>
  </li>
</template>
