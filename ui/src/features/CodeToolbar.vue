<script setup lang="ts">
/**
 * The Wrap / Copy strip on a fenced code block, mounted INTO the .code-toolbar div, one
 * app per <pre>, so the opaque v-html markdown subtree is otherwise untouched. Button
 * feedback is component state, so the copy timer is cleared on unmount. Wrap toggles a
 * class on the <pre> (on from the start when `wrap` is set) (the CSS rule is `.msg .bubble pre.wrap code`) — the one
 * element it touches outside its own tree.
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { copyTextToClipboard } from '../boot.js';

const props = defineProps<{ lang: string; pre: HTMLElement; wrap?: boolean }>();

const COPY = 'Copy';
const COPIED = 'Copied ✓';
const FAILED = 'Failed';
const WRAP = 'Wrap';
const UNWRAP = 'Unwrap';
const COPY_LABEL = 'Copy code to clipboard';
const WRAP_LABEL = 'Toggle line wrapping';

const copyState = ref<'idle' | 'copied' | 'error'>('idle');
const wrapping = ref(Boolean(props.wrap));
let timer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => props.pre.classList.toggle('wrap', wrapping.value));

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});

async function copy(): Promise<void> {
  const code = props.pre.querySelector('code');
  const text = code ? code.textContent : props.pre.textContent;
  const ok = await copyTextToClipboard(text || '');
  copyState.value = ok ? 'copied' : 'error';
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    copyState.value = 'idle';
  }, 1500);
}

function toggleWrap(): void {
  wrapping.value = !wrapping.value;
  props.pre.classList.toggle('wrap', wrapping.value);
}
</script>

<template>
  <span v-if="lang" class="code-lang">{{ lang }}</span
  ><button
    type="button"
    :class="wrapping ? 'code-btn wrap-code-btn active' : 'code-btn wrap-code-btn'"
    :aria-label="WRAP_LABEL"
    @click="toggleWrap"
  >{{ wrapping ? UNWRAP : WRAP }}</button
  ><button
    type="button"
    :class="copyState === 'idle' ? 'code-btn copy-code-btn' : `code-btn copy-code-btn ${copyState}`"
    :aria-label="COPY_LABEL"
    @click="copy"
  >{{ copyState === 'copied' ? COPIED : copyState === 'error' ? FAILED : COPY }}</button>
</template>
