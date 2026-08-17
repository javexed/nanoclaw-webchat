<script setup lang="ts">
/**
 * An agent's SSH deploy keys — sixtieth island.
 *
 * Mounted into <ul id="agent-keys-list">, exclusively owned by this module.
 * #agent-keys-count sits outside the mount point and keeps its imperative
 * write: it SETS text on static markup rather than building anything.
 *
 * The row builder lived in legacy.js and was reached through the deps bridge —
 * agents.ts called deps.deployKeyRowEl() per key. That indirection is what the
 * island removes; the shaping now happens in renderAgentKeys and the markup
 * lives here.
 *
 * The private half of the keypair never reaches the client, so "Copy public
 * key" is the whole workflow — it is the half you paste into authorized_keys
 * or a git host — which is why it takes the prominent button and Remove takes
 * the danger one.
 *
 * The meta line carries the ready-to-paste ssh command when a login target is
 * set and falls back to the path plus a note when it is not. It is composed in
 * renderAgentKeys rather than here: it is one string in the DOM, and splitting
 * it across template nodes would put text nodes where the original had one.
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
