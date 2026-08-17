<script setup lang="ts">
/**
 * Which approval actions may be pre-judged — fifty-sixth island.
 *
 * Mounted into <div id="prejudge-actions-list">, exclusively owned by this
 * module. The #prejudge-actions-group hidden flag stays imperative: the whole
 * group disappears when no judge model is configured, which is a decision about
 * the feature rather than the rows.
 *
 * NEVER-list rows are rendered disabled AND unchecked, and that pairing is
 * load-bearing: the save reads `input:not(:disabled):checked`, so a disabled row
 * can never contribute to the saved list even if something ticked it. Their
 * label carries the reason on hover — always needs a human.
 *
 * The ticks stay in the DOM because that save reads them with querySelectorAll.
 * Same contract as the agent pickers and the probe list.
 */
import { prejudgeRows } from './prejudge-state.js';

const props = defineProps<{ onToggle: (el: HTMLInputElement) => void }>();

const NEVER_TITLE = 'Always needs a human';
</script>

<template>
  <label
    v-for="r in prejudgeRows"
    :key="r.action"
    :class="r.never ? 'setting-toggle prejudge-never' : 'setting-toggle'"
    v-bind="r.never ? { title: NEVER_TITLE } : {}"
  >
    <span>{{ r.action }}</span
    ><input
      type="checkbox"
      :data-action="r.action"
      :checked="r.checked"
      :disabled="r.never || undefined"
      @change="r.never ? undefined : props.onToggle($event.target as HTMLInputElement)"
    />
  </label>
</template>
