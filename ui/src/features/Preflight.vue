<script setup lang="ts">
/**
 * The webchat self-test results — fifty-ninth island.
 *
 * Mounted into <div id="selftest-results">, exclusively owned by this module.
 * Its hidden flag stays imperative — it is revealed when the run starts.
 *
 * The element previously held three different things written three different
 * ways: a plain textContent wait line, a plain textContent error, and built
 * check rows. Converting only the rows would have left two imperative writers
 * on a Vue-owned element, so the messages are phases too.
 *
 * The fix block is a copy-paste command — same shape as the reachability
 * verdict, deliberately not shared with it: the classes differ (preflight-fix
 * vs model-reachability-fix) and a shared component would need a prop to choose
 * them, which is a worse seam than eight duplicated lines.
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
