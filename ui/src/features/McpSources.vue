<script setup lang="ts">
/**
 * The MCP registry source list — nineteenth island.
 *
 * Mounted into <ul id="mcp-sources-list">, exclusively owned by this module.
 *
 * #mcp-sources (the section's hidden flag, which also encodes "not a
 * global admin") is outside the mount point and stays imperative.
 *
 * First island to render an OriginBadge. The badge is a component rather than
 * a v-html of originBadgeEl's output precisely because it carries an href
 * decision — see the note in origin-badge.ts.
 *
 * Same row idiom as the skill collections' built-in source: info column (name +
 * meta), a built-in badge, and a reversible Remove/Add — no standing prose, no
 * confirm, since adding it back is one click.
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
