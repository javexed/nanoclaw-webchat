<script setup lang="ts">
/**
 * The per-day usage sparkline, mounted into <div id="usage-spark">; hidden below two days
 * of data. Bar heights are computed upstream with a 4px floor so a near-zero day shows.
 */
import { usageBars } from './usage-state.js';
</script>

<template>
  <span v-for="(b, i) in usageBars" :key="i" class="usage-bar" :style="{ height: b.height }" :title="b.title"></span>
</template>
