<script setup lang="ts">
/**
 * The agent's model picker, mounted into <ul id="model-picker-list">. The Default row is
 * pinned at the top and NEVER filtered out — the user may be searching to confirm that
 * nothing matches. The empty note renders between Default and the matches, because "no
 * matches" is about the registered models.
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
