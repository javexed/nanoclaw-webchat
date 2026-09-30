<script setup lang="ts">
/**
 * The text field showConfirmModal borrows as its body; one app per call. State comes
 * through provide(), not props: root props never update, and a module ref would let two
 * open instances collide. The input is uncontrolled (the caller reads input.value at
 * confirm time), and @input binds only when a validator is supplied.
 */
import { inject } from 'vue';

const s = inject<any>('confirmInput');

function capture(el: any): void {
  if (!el) return;
  s.el = el;
  el.value = s.initial;
}

function onInput(): void {
  s.error = '';
  s.invalid = false;
}
</script>

<template>
  <input
    type="text"
    class="confirm-input"
    :class="s.invalid ? 'invalid' : undefined"
    :placeholder="s.placeholder"
    autocomplete="off"
    :ref="capture"
    v-on="s.validate ? { input: onInput } : {}"
  />
  <div v-if="s.validate" class="confirm-input-error" :hidden="!s.error">{{ s.error }}</div>
</template>
