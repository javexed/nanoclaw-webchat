<script setup lang="ts">
/**
 * The agent's model picker — fifty-fourth island.
 *
 * Mounted into <ul id="model-picker-list">, exclusively owned by this module.
 *
 * The Default row is pinned at the top and is NEVER filtered out, even with a
 * search query — the user may be searching precisely to confirm that nothing
 * matches and the fallback is what they want. It is shaped upstream and enters
 * the list like any other row.
 *
 * The empty note can appear ALONGSIDE the Default row: "no matches" is about
 * the registered models, not about the list being empty. That is why it renders
 * between Default and the matches rather than replacing everything.
 */
import { pickerEmptyNote, pickerRows, pickerSelected } from './model-picker-state.js';

const props = defineProps<{ onPick: (id: string) => void }>();

function rowClass(r: any) {
  const parts = ['model-picker-row'];
  if (r.isDefault) parts.push('is-default');
  if ((r.id || '') === pickerSelected.value) parts.push('selected');
  return parts.join(' ');
}

function onKey(e: KeyboardEvent, id: string) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    props.onPick(id);
  }
}
</script>

<template>
  <template v-for="r in pickerRows" :key="r.key">
    <li
      :class="rowClass(r)"
      tabindex="0"
      :data-model-id="r.id || ''"
      @click="props.onPick(r.id || '')"
      @keydown="onKey($event, r.id || '')"
    >
      <div class="model-picker-row-top">
        <span class="model-picker-row-name">{{ r.name }}</span
        ><span :class="r.badgeClass">{{ r.badgeText }}</span>
      </div>
      <div class="model-picker-row-sub">{{ r.sub }}</div>
    </li>
    <li v-if="r.isDefault && pickerEmptyNote" class="model-picker-empty">{{ pickerEmptyNote }}</li>
  </template>
</template>
