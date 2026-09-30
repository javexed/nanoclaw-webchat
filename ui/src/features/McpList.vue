<script setup lang="ts">
/**
 * The MCP server list, mounted into <ul id="mcp-list">. makeRowActivatable()'s behaviour
 * (role/tabindex, click, Enter/Space) is inlined because that helper attaches listeners
 * imperatively. The active row uses v-bind of an object; :class would emit class="".
 */
import { computed } from 'vue';
import { mcpServers, selectedMcpId } from './mcp-list-state.js';

const emit = defineEmits<{ (e: 'pick', id: string): void }>();

const sorted = computed(() =>
  [...mcpServers.value].sort((a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? ''))),
);

/** Bound, not template text: template text carries the surrounding whitespace. */
const emptyMessage = 'No MCP servers registered. Click "+ New server" to add one.';

/** The health tooltip, including the optional reason. */
function healthTitle(h: any): string {
  if (h.status === 'ok') return `Healthy — ${h.toolCount ?? '?'} tools`;
  if (h.status === 'drift') return 'Tool surface changed since approval';
  if (h.status === 'auth') return 'Rejecting credentials';
  return `Unreachable${h.reason ? `: ${h.reason}` : ''}`;
}
</script>

<template>
  <li v-if="sorted.length === 0" :style="{ cursor: 'default', opacity: 0.6 }">{{ emptyMessage }}</li>
  <template v-else>
    <li
      v-for="server in sorted"
      :key="server.id"
      :data-mcp-id="server.id"
      v-bind="server.id === selectedMcpId ? { class: 'active' } : {}"
      role="button"
      tabindex="0"
      @click="emit('pick', server.id)"
      @keydown.enter.prevent="emit('pick', server.id)"
      @keydown.space.prevent="emit('pick', server.id)"
    >
      <span :class="`model-kind-badge kind-${server.transport}`">{{ server.transport }}</span>
      <span
        v-if="server.health && server.transport !== 'stdio'"
        :class="`mcp-health-dot mcp-health-${server.health.status}`"
        :title="healthTitle(server.health)"
      ></span>
      <span class="model-row-name">{{ server.name }}</span>
      <span v-if="server.agents_assigned > 0" class="model-row-uses">{{ server.agents_assigned }}×</span>
    </li>
  </template>
</template>
