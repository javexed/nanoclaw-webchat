<script setup lang="ts">
/**
 * The tools a probed MCP server advertises — twentieth island.
 *
 * Mounted into <ul id="mcp-probe-tools">, exclusively owned by this module.
 *
 * The probe's other outputs — #mcp-probe-kind, #mcp-probe-notes, the suggested
 * name in #mcp-probe-name and the #mcp-probe-results hidden flag — are all
 * outside the mount point and stay imperative.
 *
 * The description keeps its inline opacity. It is presentational and belongs in
 * style.css, but moving it would be a CSS change riding along in a conversion
 * commit, and this phase does not do that.
 */
import { computed } from 'vue';
import { probeTools } from './mcp-panel-state.js';

const EMPTY = 'Connected, but the server advertises no tools.';
const DIM = { opacity: '0.75' };

const rows = computed(() =>
  probeTools.value.map((t: any, i: number) => ({
    key: `${i}:${t.name}`,
    name: t.name,
    // Bound as one string including the leading em-dash and spaces, the way the
    // imperative version set textContent — not "— {{ desc }}" in the template,
    // which would split it across text nodes.
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
