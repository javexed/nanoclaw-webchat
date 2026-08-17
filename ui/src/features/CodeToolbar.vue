<script setup lang="ts">
/**
 * The Wrap / Copy strip on a fenced code block.
 *
 * Mounted INTO the .code-toolbar div itself, one app per <pre>, so the toolbar
 * element is the host and its children are the component. That keeps the
 * markdown subtree — which Vue holds as opaque v-html and never diffs into —
 * untouched apart from the strip that decorateCodeBlocks was already inserting.
 *
 * The two buttons' feedback used to live in a DELEGATED handler on #messages
 * that wrote btn.textContent and toggled classes: 'Copied ✓' for 1.5s, then
 * back. That handler is gone; both are component state now, which is also why
 * the copy timer can be cleared on unmount instead of firing into a detached
 * node.
 *
 * Wrap toggles a class on the <pre>, not on itself — the CSS rule is
 * `.msg .bubble pre.wrap code`. The component reaches its own host's parent for
 * that, which is the one thing it touches outside its own tree, and it is the
 * same element the delegated handler reached through btn.closest('pre').
 */
import { onUnmounted, ref } from 'vue';
import { copyTextToClipboard } from '../boot.js';

const props = defineProps<{ lang: string; pre: HTMLElement }>();

const COPY = 'Copy';
const COPIED = 'Copied ✓';
const FAILED = 'Failed';
const WRAP = 'Wrap';
const UNWRAP = 'Unwrap';
const COPY_LABEL = 'Copy code to clipboard';
const WRAP_LABEL = 'Toggle line wrapping';

const copyState = ref<'idle' | 'copied' | 'error'>('idle');
const wrapping = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

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
