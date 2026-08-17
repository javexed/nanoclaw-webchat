<script setup lang="ts">
/**
 * The Codex device pairing code — forty-seventh island.
 *
 * Mounted into <p id="user-creds-oauth-codex-code">. Its hidden flag stays
 * imperative: the line is shown only for Codex flows, which is a decision the
 * mint modal makes about the whole step.
 *
 * The copy button exists because the operator has to TYPE this code at the
 * ChatGPT sign-in page — copy beats retyping a device code. On success the
 * icon swaps to a check for 1500ms; the swap is state here rather than
 * setAttribute on a <use> href, but the same 1500ms and the same two icons.
 *
 * Only the rest of openOauthMintModal is left imperative, and deliberately: it
 * APPLIES STATE to static markup (hidden flags, textContent, href) rather than
 * building DOM. Converting that would mean claiming a whole modal to set six
 * properties.
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
