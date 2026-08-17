<script setup lang="ts">
/**
 * The router's recent decisions — twenty-third island.
 *
 * Mounted into <div id="routing-decisions-list">, exclusively owned by this
 * module.
 *
 * Rows are <div>, not <li> — the host is a div and always was. Worth saying
 * because every other list island in this phase is a <ul>.
 *
 * The row text is ONE binding, not five interpolations with separators between
 * them. The imperative version set textContent, which is a single text node;
 * `{{ when }} · {{ mode }} · …` would produce nine. They serialise the same, but
 * the DOM diff compares what is there, so the shapes are kept the same too.
 *
 * esc() is gone from the empty message: it was needed because the string went
 * into innerHTML, and a text binding escapes by construction.
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
    const rawModel = d.final_model || d.bound_model || '';
    const model = rawModel === '__escalate__' ? 'escalated to Claude' : rawModel;
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
