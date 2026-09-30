<script setup lang="ts">
/**
 * The MCP registry source list, mounted into <ul id="mcp-sources-list">; #mcp-sources'
 * hidden flag (which also encodes "not a global admin") stays with the renderer. Badges
 * are OriginBadge components because they carry an href decision (see origin-badge.ts).
 * Remove/Add is reversible in one click, so there is no confirm.
 */
import { computed } from 'vue';
import OriginBadge from './OriginBadge.vue';
import { mcpSources } from './mcp-panel-state.js';

const props = defineProps<{ onToggle: (id: string, off: boolean) => void }>();

const BUILT_IN = 'built-in';
const REMOVED_NOTE = 'Removed from Add MCP server';

const rows = computed(() =>
  mcpSources.value.map((src: any) => {
    const off = !!(src.removed || src.disabled);
    return {
      id: src.id,
      off,
      origin: { label: 'MCP registry', url: src.url, official: false },
      // A long plain URL breaks .skill-head's pill-sized layout, so the scheme
      // is stripped — same as the compact form the skill collections lead with.
      meta: off ? REMOVED_NOTE : String(src.url).replace(/^https?:\/\//, ''),
      toggleClass: off ? 'btn btn-ghost' : 'skill-delete',
      toggleLabel: off ? 'Add' : 'Remove',
    };
  }),
);
</script>

<template>
  <li v-for="r in rows" :key="r.id" :class="r.off ? 'skill-source-row source-disabled' : 'skill-source-row'">
    <div class="skill-info">
      <div class="skill-head"><OriginBadge :origin="r.origin" /></div>
      <span class="skill-desc">{{ r.meta }}</span>
    </div>
    <span class="skill-badge">{{ BUILT_IN }}</span>
    <button type="button" :class="r.toggleClass" @click="props.onToggle(r.id, r.off)">{{ r.toggleLabel }}</button>
  </li>
</template>
