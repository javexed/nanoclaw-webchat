<script setup lang="ts">
/**
 * Per-user token usage rows — forty-second island.
 *
 * Mounted into <tbody id="usage-tbody">. The table's own hidden flag and
 * #usage-empty are outside it and stay imperative — they swap the whole table
 * for an empty note, which is a decision about the section, not the rows.
 *
 * Every cell but the first carries .usage-num (right-aligned numerics); the
 * first is the user handle. Shaped upstream so the component holds no
 * formatting rules.
 */
import { usageRows } from './usage-state.js';
</script>

<template>
  <tr v-for="(r, i) in usageRows" :key="i">
    <td v-for="(c, j) in (r.cells as any[])" :key="j" v-bind="j > 0 ? { class: 'usage-num' } : {}">{{ c ?? '' }}</td>
  </tr>
</template>
