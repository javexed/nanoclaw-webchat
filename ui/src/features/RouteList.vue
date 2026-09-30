<script setup lang="ts">
/**
 * The auto-routing rule list, mounted into <ul id="route-list">; same grammar as the
 * Agents/Models/MCP lists, with makeRowActivatable() inlined as in McpList. The active row
 * keys off routeSelectedIdx alone (routing.ts resets it to -1 when the detail closes; root
 * props are not reactive).
 */
import { routeDefaultName, routeRows, routeSelectedIdx } from './route-list-state.js';

const props = defineProps<{ onActivate: (index: number) => void }>();

const EMPTY = 'No routes yet — add one, or a suggestion will offer to.';
const NO_DESC = 'No description — click to add the rule';
const DEFAULT_CHIP = 'default';
const PINNED = 'pinned';

function onKey(e: KeyboardEvent, i: number) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    props.onActivate(i);
  }
}
</script>

<template>
  <li v-if="routeRows.length === 0" class="ollama-muted">{{ EMPTY }}</li>
  <li
    v-for="(r, i) in routeRows"
    :key="r.name"
    :class="i === routeSelectedIdx ? 'route-row active' : 'route-row'"
    role="button"
    tabindex="0"
    @click="props.onActivate(i)"
    @keydown="onKey($event, i)"
  >
    <div class="route-row-top">
      <span class="model-row-name">{{ r.name }}</span
      ><span v-if="routeDefaultName === r.name" class="model-kind-badge model-default-badge">{{ DEFAULT_CHIP }}</span
      ><span v-if="r.pinned" class="model-row-uses">{{ PINNED }}</span
      ><span class="model-row-host">{{ r.model || '' }}</span>
    </div>
    <div :class="r.description ? 'route-row-desc' : 'route-row-desc empty'">{{ r.description || NO_DESC }}</div>
  </li>
</template>
