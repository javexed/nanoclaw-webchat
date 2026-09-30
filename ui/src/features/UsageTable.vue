<script setup lang="ts">
/**
 * Per-user token usage rows, mounted into <tbody id="usage-tbody">; the table/empty-note
 * swap stays with the renderer. Every cell but the first (the handle) carries .usage-num.
 * Rows are shaped upstream, so no formatting rules live here.
 */
import { usageRows } from './usage-state.js';
</script>

<template>
  <tr v-for="(r, i) in usageRows" :key="i">
    <td v-for="(c, j) in (r.cells as any[])" :key="j" v-bind="j > 0 ? { class: 'usage-num' } : {}">{{ c ?? '' }}</td>
  </tr>
</template>
