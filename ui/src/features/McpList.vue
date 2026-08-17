<script setup lang="ts">
/**
 * The MCP server list — second Vue island.
 *
 * Mounted into <ul id="mcp-list">, which no other module writes to.
 *
 * Replicates makeRowActivatable() inline (role/tabindex, click, Enter/Space)
 * rather than calling it: that helper attaches listeners imperatively to a node
 * it is handed, which is the thing an island exists to stop doing. The
 * behaviour is identical — verified by diffing the rendered DOM.
 *
 * Vue rendering notes carried over from AgentList.vue, both re-checked here:
 *   - the active row uses v-bind of a whole object, not :class. Both
 *     :class="{ active: false }" and :class="undefined" emit class="" on every
 *     other row, because Vue normalises class to a string instead of omitting.
 *   - never write explanatory comments in the TEMPLATE; Vue renders them into
 *     the DOM as comment nodes.
 */
import { computed } from 'vue';
import { mcpServers, selectedMcpId } from './mcp-list-state.js';

const emit = defineEmits<{ (e: 'pick', id: string): void }>();

const sorted = computed(() =>
  [...mcpServers.value].sort((a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? ''))),
);

/**
 * Bound as an expression, not written as template text. Text on its own line in
 * a template renders with the surrounding whitespace, which the imperative
 * textContent assignment never produced — caught by the rendered-DOM diff.
 */
const emptyMessage = 'No MCP servers registered. Click "+ New server" to add one.';

/** Matches the imperative title text exactly, including the optional reason. */
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
