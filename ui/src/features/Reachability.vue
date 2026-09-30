<script setup lang="ts">
/**
 * The model endpoint reachability verdict, mounted into #model-reachability-panel, which
 * models.ts creates after #model-live-facts and shows only for endpoints an agent dials
 * directly. Three phases: wait line, transport/HTTP error, verdict. The fix block is a
 * copy-paste command, so Copy is how the operator applies the remedy.
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
