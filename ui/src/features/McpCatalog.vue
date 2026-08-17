<script setup lang="ts">
/**
 * The MCP marketplace catalog — forty-sixth island.
 *
 * Mounted into <ul id="mcp-catalog-list">, exclusively owned by this module.
 * #mcp-catalog-status is outside it and stays imperative — it carries the
 * result count AND the fetch error, which are section-level, not row-level.
 *
 * The wait row is written out rather than v-html'd from loadingRow(): that
 * helper returns the <li> itself, so binding it would nest one. Same call made
 * for SkillPool, same DESIGN.md §5 wait primitive, and the DOM diff is what
 * holds the two to it.
 *
 * The 'error' phase renders NOTHING — the imperative version cleared the list
 * and put the message in the status line, so an empty list plus status text is
 * the correct shape, not an inline error row.
 */
import { computed } from 'vue';
import OriginBadge from './OriginBadge.vue';
import { mcpCatalog, mcpCatalogPhase, mcpCatalogQuery } from './mcp-panel-state.js';

const props = defineProps<{ onUse: (row: any) => void }>();

const USE = 'Use';
const waitLabel = computed(() => (mcpCatalogQuery.value ? 'Searching…' : 'Loading catalog…'));
</script>

<template>
  <li v-if="mcpCatalogPhase === 'loading'" class="skills-empty">
    <span class="btn-spinner" aria-hidden="true"></span>{{ waitLabel }}
  </li>
  <template v-else-if="mcpCatalogPhase === 'ready'">
    <li v-for="(s, i) in mcpCatalog" :key="i" class="mcp-catalog-row">
      <div class="mcp-catalog-head">
        <span class="mcp-catalog-title">{{ s.title }}</span
        ><OriginBadge v-if="s.origin" :origin="s.origin" /><span :class="s.kindClass">{{ s.kindText }}</span>
      </div>
      <div class="mcp-catalog-desc">{{ s.desc }}</div>
      <div class="mcp-catalog-target">{{ s.target }}</div>
      <div class="mcp-catalog-actions">
        <button type="button" class="btn btn-secondary" @click="props.onUse(s.raw)">{{ USE }}</button>
      </div>
    </li>
  </template>
</template>
