<script setup lang="ts">
/**
 * A compact icon button that copies a string to the clipboard and shows the
 * result on itself — the copy glyph becomes a check for ~1.4s, or the label
 * flips to "Couldn't copy" on failure. The `.btn-icon` role (DESIGN.md §2) and
 * the inline state echo the chat code block's copy affordance, so a row that
 * hands the user a value to paste (a deploy key, a pairing code) gets the same
 * one-tap control instead of a wide labelled button. No toast: the swap on the
 * control is the outcome (DESIGN.md §5 — in-progress/outcome lives on the
 * thing that's working).
 */
import { onBeforeUnmount, ref } from 'vue';

import { copyTextToClipboard } from '../boot.js';

const props = defineProps<{
  /** What to copy. A getter so a row that re-renders always copies its current value. */
  text: string | (() => string);
  /** Spoken/tooltip label for the idle state, e.g. "Copy public key". */
  label: string;
}>();

const state = ref<'idle' | 'copied' | 'error'>('idle');
let timer: ReturnType<typeof setTimeout> | undefined;

const aria = () =>
  state.value === 'copied' ? 'Copied' : state.value === 'error' ? "Couldn't copy" : props.label;

async function copy(): Promise<void> {
  clearTimeout(timer);
  const text = typeof props.text === 'function' ? props.text() : props.text;
  state.value = (await copyTextToClipboard(text)) ? 'copied' : 'error';
  timer = setTimeout(() => (state.value = 'idle'), 1400);
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <button
    type="button"
    class="btn-icon"
    :class="state"
    :aria-label="aria()"
    :title="aria()"
    @click="copy"
  >
    <svg class="icon" aria-hidden="true">
      <use :href="state === 'copied' ? '#i-check' : '#i-copy'" />
    </svg>
  </button>
</template>
