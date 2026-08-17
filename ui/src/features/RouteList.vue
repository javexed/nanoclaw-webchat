<script setup lang="ts">
/**
 * The auto-routing rule list — fifty-second island.
 *
 * Mounted into <ul id="route-list">, exclusively owned by this module.
 *
 * Same list grammar as Agents/Models/MCP: rows open a detail aside, chips carry
 * state (default / pinned / escalates), and the bound model rides as dim meta.
 *
 * makeRowActivatable() is replicated inline — role/tabindex, click, Enter and
 * Space — rather than called. That helper attaches listeners imperatively to a
 * node it is handed, which is the thing an island exists to stop doing. McpList
 * made the same call for the same reason.
 *
 * The active row keys off routeSelectedIdx alone, which legacy sets to -1 when
 * the detail pane is closed. A separate `detailOpen` prop would be read once at
 * createApp and never update — root props are not reactive.
 *
 * An escalating route shows no bound model: escalation hands the turn to
 * Claude, so there is nothing local to name.
 */
import { routeDefaultName, routeRows, routeSelectedIdx } from './route-list-state.js';

const props = defineProps<{ onActivate: (index: number) => void }>();

const EMPTY = 'No routes yet — add one, or a suggestion will offer to.';
const NO_DESC = 'No description — click to add the rule';
const ESCALATE = 'escalate';
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
      <span v-if="r.escalate" class="model-kind-badge kind-anthropic">{{ ESCALATE }}</span
      ><span class="model-row-name">{{ r.name }}</span
      ><span v-if="routeDefaultName === r.name" class="model-kind-badge model-default-badge">{{ DEFAULT_CHIP }}</span
      ><span v-if="r.pinned" class="model-row-uses">{{ PINNED }}</span
      ><span v-if="!r.escalate" class="model-row-host">{{ r.model || '' }}</span>
    </div>
    <div :class="r.description ? 'route-row-desc' : 'route-row-desc empty'">{{ r.description || NO_DESC }}</div>
  </li>
</template>
