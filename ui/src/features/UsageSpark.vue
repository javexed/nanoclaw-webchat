<script setup lang="ts">
/**
 * The per-day usage sparkline — forty-third island.
 *
 * Mounted into <div id="usage-spark">. Its hidden flag stays imperative: the
 * sparkline is suppressed entirely below two days of data, which is a decision
 * about whether to show the element at all.
 *
 * Bar heights are computed upstream against the range's max, with a 4px floor
 * so a near-zero day is still visible.
 */
import { usageBars } from './usage-state.js';
</script>

<template>
  <span v-for="(b, i) in usageBars" :key="i" class="usage-bar" :style="{ height: b.height }" :title="b.title"></span>
</template>
