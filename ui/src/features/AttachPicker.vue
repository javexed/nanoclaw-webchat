<script setup lang="ts">
/**
 * The attach picker's row list — used by several panels through a config
 * object (items / searchText / name / meta / isAttached / onToggle).
 *
 * Mounted into <ul id="attach-picker-list">. The rows arrive PRE-SHAPED:
 * resolving the config belongs to the caller that supplied it, not to a
 * component that would then need to know every panel's item type.
 *
 * The imperative version disabled a row mid-flight with
 * `li.style.pointerEvents = 'none'` and then re-rendered itself. Here the row
 * emits and the caller re-syncs the refs — a re-render is a data change, not a
 * function call.
 */
import { attachRows, attachEmptyText } from './attach-picker-state.js';

const emit = defineEmits<{ (e: 'toggle', key: string, attached: boolean, row: HTMLElement): void }>();

function act(ev: Event, r: { key: string; attached: boolean }) {
  const li = ev.currentTarget as HTMLElement;
  li.style.pointerEvents = 'none';
  emit('toggle', r.key, r.attached, li);
}
</script>

<template>
  <li v-if="attachRows.length === 0" class="model-picker-empty">{{ attachEmptyText }}</li>
  <template v-else>
    <li
      v-for="r in attachRows"
      :key="r.key"
      :class="'model-picker-row attach-picker-row' + (r.attached ? ' selected' : '')"
      tabindex="0"
      @click="act($event, r)"
      @keydown.enter.prevent="act($event, r)"
      @keydown.space.prevent="act($event, r)"
    >
      <div class="model-picker-row-top">
        <span class="model-picker-row-name">{{ r.name }}</span>
        <span class="attach-picker-toggle">{{ r.attached ? '−' : '+' }}</span>
      </div>
      <div v-if="r.meta" class="model-picker-row-sub">{{ r.meta }}</div>
    </li>
  </template>
</template>
