<script setup lang="ts">
/**
 * The endpoint probe's model checklist, mounted into <ul id="model-probe-list">.
 * Checkboxes and name inputs keep their state in the DOM because the submit path reads
 * them there. A single advertised model is pre-checked — the common case.
 */
import { probeEmptyNote, probeRows, probeSingle } from './probe-results-state.js';

const FLEX = { flex: '1' };

/** Assigned as a property, not bound (a bound `value` renders an attribute); uncontrolled. */
function setName(el: any, name: string) {
  if (el && el.value === '') el.value = name;
}
const NAME_PLACEHOLDER = 'Display name';
</script>

<template>
  <li v-if="probeRows.length === 0" class="empty-note">{{ probeEmptyNote }}</li>
  <li v-for="r in probeRows" :key="r.modelId">
    <label>
      <input type="checkbox" :value="r.modelId" :checked="probeSingle" /><span :style="FLEX">{{ r.modelId }}</span>
    </label>
    <input
      type="text"
      :ref="(el: any) => setName(el, r.name)"
      :placeholder="NAME_PLACEHOLDER"
      :data-model-id="r.modelId"
    />
  </li>
</template>
