<script setup lang="ts">
/**
 * The toggle(s) showConfirmModal borrows as its body — sixty-fifth island.
 *
 * Same per-instance shape as ConfirmInput, and state arrives the same way, for
 * the same reason.
 *
 * The checkbox is UNCONTROLLED and its state is read at confirm time from the
 * captured element. `checked` does not reflect to an attribute (measured in
 * #244), so :checked would emit one the imperative `cb.checked` read never
 * produced — and there is nothing here that re-renders, so binding buys
 * nothing anyway.
 *
 * The note is optional and comes AFTER the label, matching the append order.
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
