<script setup lang="ts">
/**
 * An agent's live sessions — fifteenth island.
 *
 * Mounted into <ul id="agent-sessions-list">, exclusively owned by this module.
 *
 * #agent-sessions-count is outside the mount point and stays imperative.
 *
 * The three non-row states — loading, fetch failure, empty — were three
 * different innerHTML writes. They are one phase ref here, which is what stops
 * the "Loading…" row from surviving a failure: the imperative version only
 * cleared it because every exit path happened to overwrite the same element.
 *
 * The sub-line is bound as ONE string rather than "{{ status }} · {{ when }}".
 * Both serialise the same today, but the imperative version put a single text
 * node there and the interpolated form puts three; keeping it one binding means
 * the DOM diff is comparing like for like.
 */
import { computed } from 'vue';
import { sessions, sessionsError, sessionsPhase } from './agent-detail-state.js';

const props = defineProps<{ onReset: (sessionId: string, el: HTMLElement) => void }>();

const LOADING = 'Loading…';
const EMPTY = 'No active sessions.';
const RESET_TITLE = 'Reset this session (inject /clear — drops context, next turn starts fresh)';
/**
 * Bound, not written as template text. `btn.textContent = 'Reset'` produced
 * exactly "Reset"; template text carries the surrounding newlines. This has
 * caught three islands already.
 */
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
  <li v-if="sessionsPhase === 'loading'" class="agent-session-row muted">{{ LOADING }}</li>
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
