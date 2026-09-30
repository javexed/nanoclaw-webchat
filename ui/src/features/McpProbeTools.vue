<script setup lang="ts">
/**
 * The tools a probed MCP server advertises, mounted into <ul id="mcp-probe-tools">; the
 * probe's other outputs are outside the mount point.
 */
import { computed } from 'vue';
import { probeTools } from './mcp-panel-state.js';

const EMPTY = 'Connected, but the server advertises no tools.';
const DIM = { opacity: '0.75' };

const rows = computed(() =>
  probeTools.value.map((t: any, i: number) => ({
    key: `${i}:${t.name}`,
    name: t.name,
    // One string including the leading em-dash, not "— {{ desc }}", which would split it
    // across text nodes.
    desc: t.description ? ` — ${t.description}` : '',
  })),
);
</script>

<template>
  <li v-if="rows.length === 0" class="empty-note">{{ EMPTY }}</li>
  <template v-else>
    <li v-for="r in rows" :key="r.key">
      <b>{{ r.name }}</b
      ><span v-if="r.desc" :style="DIM">{{ r.desc }}</span>
    </li>
  </template>
</template>
