<script setup lang="ts">
/**
 * The toggle(s) showConfirmModal borrows as its body; per-instance and provide()-injected
 * like ConfirmInput. The checkbox is uncontrolled and read from the captured element at
 * confirm time (nothing here re-renders). The optional note comes after the label.
 */
import { inject } from 'vue';

const s = inject<any>('confirmToggle');

function capture(el: any, i: number | string): void {
  if (el) s.els[Number(i)] = el;
}
</script>

<template>
  <label v-for="(label, i) in s.labels" :key="i" class="setting-toggle"
    ><span>{{ label }}</span
    ><input type="checkbox" :ref="(el) => capture(el, i)"
  /></label>
  <div v-if="s.note" class="import-note">{{ s.note }}</div>
</template>
