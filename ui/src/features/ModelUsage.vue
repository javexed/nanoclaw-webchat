<script setup lang="ts">
/**
 * The "assigned to" line in the model detail pane — fifty-first island.
 *
 * Mounted into <div id="model-detail-usage">, exclusively owned by this module.
 *
 * The rest of openModelDetail stays imperative and that is deliberate: it
 * APPLIES STATE to static markup — title, badge, explainer, four input values,
 * a hidden flag — rather than building DOM. This block is the only part that
 * builds anything. Third time this shape has come up (renderTtsSetupSettings,
 * openOauthMintModal, here), so the rule is worth stating: convert what BUILDS,
 * leave what SETS.
 *
 * The prefix is a bare text node followed by chips with no separator, exactly
 * as appendChild(createTextNode(…)) produced — so it is bound rather than
 * written as template text, which would carry the surrounding newlines.
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
