<script setup lang="ts">
/**
 * Which approval actions may be pre-judged, mounted into <div id="prejudge-actions-list">.
 * NEVER-list rows are disabled AND unchecked, and that pairing is load-bearing: the save
 * reads `input:not(:disabled):checked` from the DOM, so a disabled row can never reach
 * the saved list even if something ticked it.
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
