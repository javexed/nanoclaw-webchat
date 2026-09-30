<script setup lang="ts">
/**
 * The webchat self-test results, mounted into <div id="selftest-results">. The wait line,
 * the error and the check rows are all phases, so nothing else writes this element. The
 * fix block mirrors Reachability's but is not shared: the classes differ.
 */
import { ref } from 'vue';
import { preflightChecks, preflightMessage, preflightPhase } from './preflight-state.js';

const props = defineProps<{ onCopy: (text: string) => Promise<boolean> }>();

const COPY = 'Copy fix';
const COPIED = 'Copied';

const copied = ref<string>('');
let timer: ReturnType<typeof setTimeout> | null = null;

async function copy(fix: string) {
  if (!(await props.onCopy(fix))) return;
  copied.value = fix;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (copied.value = ''), 1500);
}
</script>

<template>
  <template v-if="preflightPhase !== 'checks'">{{ preflightMessage }}</template>
  <template v-else>
    <div v-for="(c, i) in preflightChecks" :key="i" :class="`preflight-check status-${c.status}`">
      <div class="preflight-check-head">{{ c.head }}</div>
      <template v-if="c.fix">
        <pre class="preflight-fix">{{ c.fix }}</pre>
        <button type="button" class="btn btn-ghost" @click="copy(c.fix)">{{ copied === c.fix ? COPIED : COPY }}</button>
      </template>
    </div>
  </template>
</template>
