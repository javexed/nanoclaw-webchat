<script setup lang="ts">
/**
 * On a rate-limit notice that says when the limit resets: "Retry at <time>"
 * schedules the server to re-send your last message in this thread then. While
 * one is pending it shows instead, with Cancel for who scheduled it or a room
 * admin. Pure logic in limit-retry.ts.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { showToast } from '../core/toast.js';
import { canCancelLimitRetry, conflictRetry, limitRetryTime, limitRetryView } from './limit-retry.js';
import { messages, type MsgRow } from './transcript-state.js';

const props = defineProps<{ row: MsgRow }>();
const busy = ref(false);

// "Now", a minute at a time: the offer goes once the reset passes, and the
// label's day changes at midnight, with nothing else re-rendering the row.
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 60_000);
onBeforeUnmount(() => clearInterval(tick));

const view = computed(() => limitRetryView(props.row, messages.value, now.value));
const label = computed(() => {
  const at = props.row.limitRetryAt ?? props.row.limitResetsAt;
  if (at == null) return '';
  const time = limitRetryTime(at, now.value);
  return view.value === 'scheduled' ? `Retrying at ${time}` : `Retry at ${time}`;
});
const canCancel = computed(() =>
  canCancelLimitRetry(
    props.row.limitRetryBy,
    state.myIdentity,
    state.lastRoomsList.find((r) => r.id === state.currentRoom)?.canArchive === true,
  ),
);

const url = () => `/api/rooms/${encodeURIComponent(state.currentRoom ?? '')}/limit-retry`;

async function schedule(): Promise<void> {
  if (busy.value || !props.row.id) return;
  busy.value = true;
  try {
    const r = await apiJson(url(), { method: 'POST', body: { message_id: props.row.id } });
    props.row.limitRetryAt = r.retry_at;
    props.row.limitRetryBy = typeof r.by === 'string' ? r.by : state.myIdentity;
  } catch (err: any) {
    // The thread already has one pending: show it where it is, not an error.
    const pending = err?.status === 409 ? conflictRetry(err.body) : null;
    if (pending) {
      const target = messages.value.find((m) => m.id === pending.noticeId) ?? props.row;
      target.limitRetryAt = pending.retryAt;
      target.limitRetryBy = pending.by;
    } else {
      showToast('Could not schedule the retry: ' + (err?.message || err), { kind: 'error' });
    }
  } finally {
    busy.value = false;
  }
}

async function cancel(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await apiJson(`${url()}?thread_id=${encodeURIComponent(props.row.limitThread || 'main')}`, { method: 'DELETE' });
    props.row.limitRetryAt = null;
    props.row.limitRetryBy = null;
  } catch (err: any) {
    showToast('Could not cancel the retry: ' + (err?.message || err), { kind: 'error' });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="view" class="limit-retry" aria-live="polite">
    <button v-if="view === 'offer'" type="button" class="btn btn-secondary" :disabled="busy" @click="schedule">
      {{ label }}
    </button>
    <template v-else>
      <span class="limit-retry-at">{{ label }}</span>
      <button v-if="canCancel" type="button" class="btn btn-ghost" :disabled="busy" @click="cancel">Cancel</button>
    </template>
  </div>
</template>
