<script setup lang="ts">
/**
 * MCP servers attached to the open agent.
 *
 * Mounted into <ul id="agent-mcp-list">. The fetch and the count badge stay in
 * renderAgentMcp() — an island renders state, it does not own IO.
 *
 * The remove button's icon is an SVG string from lucide(), so it is bound with
 * v-html exactly as the imperative version assigned innerHTML.
 */
import { lucide } from '../core/dom.js';
import { agentMcpRows } from './agent-mcp-state.js';

const emit = defineEmits<{ (e: 'detach', server: any): void }>();
const xIcon = lucide('x');
</script>

<template>
  <li v-for="s in agentMcpRows" :key="s.id" class="agent-mcp-row">
    <div class="agent-mcp-info">
      <span class="agent-mcp-name">{{ s.name }}</span>
      <span class="agent-mcp-meta">{{ s.transport }} · {{ s.target }}</span>
    </div>
    <button type="button" class="agent-mcp-remove" :aria-label="`Detach ${s.name}`" v-html="xIcon" @click="emit('detach', s)"></button>
  </li>
</template>
