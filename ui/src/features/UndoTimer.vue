<script setup lang="ts">
/**
 * The undo countdown that replaces a row's actions after Keep or Discard.
 *
 * The only undo countdown now. armUndo() is gone: it captured an element's
 * childNodes, replaced them with this markup and re-appended them afterwards,
 * which under Vue means reinserting vnode-managed nodes behind Vue's back —
 * so an island could never call it, and its last caller (the thread delete)
 * was handing it a row that ThreadRows renders.
 *
 * Both users drive it from state keyed by id — cardUndo for skill drafts,
 * threadUndo for threads — and both measure the width BEFORE arming, which is
 * what armUndo's getBoundingClientRect() call was for.
 *
 * The two-frame delay is load-bearing: the fill has to paint at 100% before the
 * transition to 0% starts, or the bar jumps straight to empty.
 */
import { onMounted, onUnmounted, ref } from 'vue';

const props = defineProps<{ label: string; seconds: number }>();
const emit = defineEmits<{ (e: 'commit'): void; (e: 'undo'): void }>();

const UNDO = 'Undo';
const fill = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!fill.value) return;
      fill.value.style.transitionDuration = `${props.seconds}s`;
      fill.value.style.width = '0%';
    }),
  );
  timer = setTimeout(() => emit('commit'), props.seconds * 1000);
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});

function undo() {
  if (timer) clearTimeout(timer);
  emit('undo');
}
</script>

<template>
  <span class="undo-timer">
    <span class="undo-timer-label">{{ label }}</span>
    <span class="undo-timer-bar"><span ref="fill"></span></span>
    <button type="button" class="btn btn-ghost" @click="undo">{{ UNDO }}</button>
  </span>
</template>
