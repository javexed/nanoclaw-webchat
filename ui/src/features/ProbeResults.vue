<script setup lang="ts">
/**
 * The endpoint probe's model checklist — fifty-third island.
 *
 * Mounted into <ul id="model-probe-list">, exclusively owned by this module.
 * The summary line above it (#model-probe-results .model-probe-summary) and the
 * panel's hidden flag stay imperative — both are outside the list.
 *
 * The checkboxes and name inputs keep their state in the DOM: the submit path
 * reads them with querySelectorAll and pulls the display name off each input.
 * Same contract as the agent pickers, and the same reason — modelling the
 * selection as state would mean changing a reader elsewhere, and the failure is
 * silent (a probe that registers nothing you ticked).
 *
 * One accepted difference: Vue emits a `checked` ATTRIBUTE where the imperative
 * version set only the property. Same call as 4.2c and 4.3b, on the same
 * evidence — the submit path reads the property, and the property matches.
 *
 * A single advertised model is pre-checked, because the one-model case is the
 * common one and unticking is cheaper than hunting for the box.
 */
import { probeEmptyNote, probeRows, probeSingle } from './probe-results-state.js';

const FLEX = { flex: '1' };

/**
 * The default display name is ASSIGNED as a property, not bound. `value` on an
 * input renders as an ATTRIBUTE under Vue, and the imperative version set only
 * the property — same call made for the skill editor's textarea in 4.3a. The
 * field is uncontrolled either way: nothing re-reads it after the probe.
 */
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
