<script setup lang="ts">
/**
 * The agent list, mounted into <ul id="agent-list">. Reads state.allAgents
 * (shallowReactive) directly, so a new array re-renders it; filter, A–Z and selection
 * come from agent-list-state.
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
      <span v-else-if="agent.provider === 'grok'" class="agent-harness-badge" title="Runs on the Grok harness"
        >Grok</span
      >
    </span>
  </li>
</template>
