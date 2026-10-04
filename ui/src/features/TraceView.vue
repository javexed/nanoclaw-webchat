<script setup lang="ts">
/**
 * What the agent did in one turn: harness · model · host · duration, the tools it
 * used, any milestones or errors, and its reasoning. The live bubble's expanded view
 * and a reply's Thoughts both render this, so a turn reads the same live and later.
 */
import { computed } from 'vue';
import { formatMs, metaLine, type TraceView } from './turn-trace-view.js';

const props = defineProps<{ view: TraceView }>();

const TOOLS = 'Tools';
const REASONING = 'Reasoning';
const OK = 'Succeeded';
const FAILED = 'Failed';
const TRUNCATED = 'Trimmed to fit';

const meta = computed(() => metaLine(props.view));
</script>

<template>
  <div class="trace-view">
    <div v-if="meta" class="trace-meta">{{ meta }}</div>
    <ul v-if="view.tools.length" class="trace-tools" :aria-label="TOOLS">
      <li v-for="(t, i) in view.tools" :key="i" class="trace-tool">
        <span
          v-if="t.ok !== null"
          :class="t.ok ? 'trace-tool-ok' : 'trace-tool-failed'"
          role="img"
          :aria-label="t.ok ? OK : FAILED"
          >{{ t.ok ? '✓' : '✗' }}</span
        ><span class="trace-tool-name">{{ t.name }}</span
        ><span v-if="t.target" class="trace-tool-target" :title="t.target">{{ t.target }}</span
        ><span v-if="t.ms !== null" class="trace-tool-ms">{{ formatMs(t.ms) }}</span>
      </li>
    </ul>
    <div v-for="(n, i) in view.notes" :key="`n${i}`" :class="`trace-note trace-note-${n.kind}`">{{ n.text }}</div>
    <div v-if="view.reasoning.length" class="trace-reasoning" :aria-label="REASONING" role="group">
      <div v-for="(l, i) in view.reasoning" :key="i" class="trace-reasoning-line">{{ l }}</div>
    </div>
    <div v-if="view.truncated" class="trace-truncated">{{ TRUNCATED }}</div>
  </div>
</template>
