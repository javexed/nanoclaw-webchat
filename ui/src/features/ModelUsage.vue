<script setup lang="ts">
/**
 * The "assigned to" line in the model detail pane, mounted into
 * <div id="model-detail-usage">; the rest of openModelDetail only sets state on static
 * markup. The prefix is bound, not template text, so no newlines surround it.
 */
import { modelAssignees } from './model-usage-state.js';

const PREFIX = 'Assigned to: ';
const NONE = 'Not assigned to any agent yet.';
</script>

<template>
  <template v-if="modelAssignees.length"
    >{{ PREFIX }}<span v-for="(n, i) in modelAssignees" :key="i" class="model-assignee-chip">{{ n }}</span></template
  >
  <template v-else>{{ NONE }}</template>
</template>
