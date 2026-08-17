<script setup lang="ts">
/**
 * The agent list — the first Vue island.
 *
 * Mounted into <ul id="agent-list">, which no other module writes to. That
 * exclusivity is why this panel went first: an island and an imperative
 * renderer sharing a container would fight, and the whole of phase 4.1 was
 * about producing containers that one owner controls.
 *
 * It reads state.allAgents directly — that object became shallowReactive in
 * phase 4.0, so pushing a new array into it re-renders this list with no
 * explicit call. The two values that are NOT reactive (the A–Z toggle and the
 * selected agent) are legacy module state; renderAgents() syncs them into refs
 * on each call, which is exactly when the imperative version re-rendered. That
 * keeps renderAgents()'s contract identical for its eight call sites while the
 * implementation stops touching the DOM.
 */
import { computed } from 'vue';
import { state } from '../core/state.js';
import { lucide } from '../core/dom.js';
import { agentFilter, agentSortAz, selectedAgentId } from './agent-list-state.js';

const emit = defineEmits<{ (e: 'pick', id: string): void }>();

const byName = (a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? ''));

/** Name OR folder — the row shows the folder as @handle, so both are searched. */
const matches = (a: any, q: string) =>
  !q || String(a.name ?? '').toLowerCase().includes(q) || String(a.folder ?? '').toLowerCase().includes(q);

const sorted = computed(() => {
  const q = agentFilter.value.trim().toLowerCase();
  const pool = state.allAgents.filter((a: any) => matches(a, q));
  return agentSortAz.value
    ? pool.sort(byName)
    : pool.sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0) || byName(a, b));
});

const botIcon = lucide('bot');
</script>

<template>
  <li
    v-for="agent in sorted"
    :key="agent.id"
    :data-agent-id="agent.id"
    v-bind="agent.id === selectedAgentId ? { class: 'active' } : {}"
    role="button"
    tabindex="0"
    @click="emit('pick', agent.id)"
    @keydown.enter.prevent="emit('pick', agent.id)"
    @keydown.space.prevent="emit('pick', agent.id)"
  >
    <span class="agent-icon" v-html="botIcon"></span>
    <span class="agent-info">
      <span class="agent-info-name">{{ agent.name ?? '' }}</span>
      <span
        v-if="(agent.status || 'active') !== 'active'"
        :class="['agent-status-badge', 'status-' + (agent.status || 'active')]"
        >{{ agent.status }}</span
      >
      <span v-if="agent.provider === 'opencode'" class="agent-harness-badge" title="Runs on the OpenCode harness"
        >OpenCode</span
      >
    </span>
  </li>
</template>
