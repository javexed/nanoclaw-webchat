<script setup lang="ts">
/**
 * The router's recent decisions, mounted into <div id="routing-decisions-list">. Rows
 * are <div>, not <li> — the host is a div. The row text is ONE binding, a single text node.
 */
import { computed } from 'vue';
import { decisions, decisionsPhase, decisionsRouter } from './routing-decisions-state.js';

const ERROR_TEXT = 'Log unavailable';

const emptyText = computed(() => `No decisions yet for ${decisionsRouter.value}`);

/** Translate the log's internal sentinels to plain language for display. */
const rows = computed(() =>
  decisions.value.map((d: any, i: number) => {
    const when = new Date(d.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const route = d.route === '__error__' ? 'classifier error' : d.route;
    const model = d.final_model || d.bound_model || '';
    return {
      key: `${i}:${d.ts}`,
      err: d.route === '__error__',
      text: `${when} · ${d.mode || 'shadow'} · ${route} → ${model} · ${d.ms} ms`,
      title: d.prompt_head || '',
    };
  }),
);
</script>

<template>
  <div v-if="decisionsPhase === 'error'" class="ollama-muted">{{ ERROR_TEXT }}</div>
  <div v-else-if="decisionsPhase === 'empty'" class="ollama-muted">{{ emptyText }}</div>
  <template v-else>
    <div
      v-for="r in rows"
      :key="r.key"
      :class="r.err ? 'routing-decision-row err' : 'routing-decision-row'"
      :title="r.title"
    >{{ r.text }}</div>
  </template>
</template>
