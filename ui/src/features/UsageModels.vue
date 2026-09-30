<script setup lang="ts">
/**
 * Model-breakdown chips, mounted into <div id="usage-models">. Attribution uses each
 * room's agent's CURRENT model, so chips describe where tokens went, not what was in
 * effect at the time.
 */
import { usageModels } from './usage-state.js';
</script>

<template>
  <span v-for="(m, i) in usageModels" :key="i" class="usage-model-chip">{{ m }}</span>
</template>
