<script setup lang="ts">
/**
 * The model endpoint reachability verdict — fifty-fifth island.
 *
 * Mounted into #model-reachability-panel, which legacy CREATES once and inserts
 * after #model-live-facts. The panel itself and its hidden flag stay imperative:
 * whether to probe at all is a decision about the model (only endpoints an agent
 * dials directly are meaningful — hosted Anthropic models have none).
 *
 * renderReachabilityOutcome is absorbed. Three phases in one element, which the
 * imperative version expressed by clearing and repainting `out`: the wait line,
 * a transport/HTTP error, and the verdict.
 *
 * The fix block is a copy-paste command, so the copy button matters more than it
 * looks — it is how the operator applies the remedy. 'Copied' for 1500ms, and a
 * toast if the clipboard write is refused.
 */
import { ref } from 'vue';
import { reachError, reachOutcome, reachPhase } from './reachability-state.js';

const props = defineProps<{ onCopy: (text: string) => Promise<boolean> }>();

const CHECKING = 'Checking reachability…';
const COPY = 'Copy fix';
const COPIED = 'Copied';

const copyLabel = ref(COPY);
let timer: ReturnType<typeof setTimeout> | null = null;

async function copy(fix: string) {
  if (!(await props.onCopy(fix))) return;
  copyLabel.value = COPIED;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (copyLabel.value = COPY), 1500);
}
</script>

<template>
  <div v-if="reachPhase === 'checking'" class="model-reachability-result">{{ CHECKING }}</div>
  <div v-else-if="reachPhase === 'error'" class="model-reachability-result warn">{{ reachError }}</div>
  <div v-else-if="reachOutcome" :class="reachOutcome.warn ? 'model-reachability-result warn' : 'model-reachability-result'">
    <div class="model-reachability-verdict">
      {{ `${reachOutcome.warn ? '✕' : '✓'} ${reachOutcome.label} — ${reachOutcome.detail}` }}
    </div>
    <template v-if="reachOutcome.fix">
      <pre class="model-reachability-fix">{{ reachOutcome.fix }}</pre>
      <button type="button" class="btn btn-ghost" @click="copy(reachOutcome.fix)">{{ copyLabel }}</button>
    </template>
  </div>
</template>
