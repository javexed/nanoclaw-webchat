<script setup lang="ts">
/**
 * An agent's live sessions, mounted into <ul id="agent-sessions-list">. Loading, error
 * and empty are one phase ref, so "Loading…" cannot survive a failure. The sub-line is
 * bound as ONE string, one text node.
 */
import { computed } from 'vue';
import { sessions, sessionsError, sessionsPhase } from './agent-detail-state.js';

const props = defineProps<{ onReset: (sessionId: string, el: HTMLElement) => void }>();

const LOADING = 'Loading…';
const EMPTY = 'No active sessions.';
const RESET_TITLE = 'Reset this session (inject /clear — drops context, next turn starts fresh)';
/** Bound, not template text: template text carries the surrounding newlines. */
const RESET_LABEL = 'Reset';

const rows = computed(() =>
  sessions.value.map((s: any) => ({
    id: s.id,
    label: s.thread_id ? `thread: ${s.thread_id}` : 'main / a2a',
    sub: `${s.container_status || 'stopped'} · ${s.last_active ? new Date(s.last_active).toLocaleString() : '—'}`,
  })),
);

function reset(id: string, e: MouseEvent) {
  props.onReset(id, e.currentTarget as HTMLElement);
}
</script>

<template>
  <li v-if="sessionsPhase === 'loading'" class="agent-session-row muted"><span class="btn-spinner" aria-hidden="true"></span>{{ LOADING }}</li>
  <li v-else-if="sessionsPhase === 'error'" class="agent-session-row muted">{{ sessionsError }}</li>
  <li v-else-if="rows.length === 0" class="agent-session-row muted">{{ EMPTY }}</li>
  <template v-else>
    <li v-for="r in rows" :key="r.id" class="agent-session-row">
      <div class="agent-session-meta">
        <span class="agent-session-label">{{ r.label }}</span
        ><span class="agent-session-sub">{{ r.sub }}</span>
      </div>
      <button
        type="button"
        class="btn btn-ghost agent-session-reset"
        :title="RESET_TITLE"
        @click="reset(r.id, $event)"
      >{{ RESET_LABEL }}</button>
    </li>
  </template>
</template>
