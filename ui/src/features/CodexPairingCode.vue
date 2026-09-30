<script setup lang="ts">
/**
 * The Codex device pairing code, mounted into <p id="user-creds-oauth-codex-code">; the
 * mint modal owns its hidden flag. Copy exists because the operator must TYPE this code at
 * the ChatGPT sign-in page; on success the icon shows a check for 1500ms.
 */
import { onUnmounted, ref } from 'vue';
import { codexActive, codexUserCode } from './codex-code-state.js';

const props = defineProps<{ onCopy: (code: string) => Promise<boolean> }>();

const PREFIX = 'Pairing code: ';
const NO_CODE = 'Open the link, then approve the sign-in.';
const COPY_TITLE = 'Copy';
const COPY_LABEL = 'Copy pairing code';

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

async function copy() {
  if (!(await props.onCopy(codexUserCode.value))) return;
  copied.value = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (copied.value = false), 1500);
}

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <template v-if="codexActive && codexUserCode"
    >{{ PREFIX }}<code>{{ codexUserCode }}</code
    ><button
      type="button"
      :class="copied ? 'codex-code-copy copied' : 'codex-code-copy'"
      :title="COPY_TITLE"
      :aria-label="COPY_LABEL"
      @click="copy"
    >
      <svg class="icon" aria-hidden="true"><use :href="copied ? '#i-check' : '#i-copy'"></use></svg></button
  ></template>
  <template v-else-if="codexActive">{{ NO_CODE }}</template>
</template>
