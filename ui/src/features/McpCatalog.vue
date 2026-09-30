<script setup lang="ts">
/**
 * The MCP marketplace catalog, mounted into <ul id="mcp-catalog-list">. The result count
 * and fetch error live in #mcp-catalog-status, so the 'error' phase renders NOTHING here.
 * The wait row matches loadingRow()'s markup (DESIGN.md §5), as in SkillPool.
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
