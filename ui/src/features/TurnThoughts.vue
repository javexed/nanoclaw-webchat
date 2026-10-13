<script setup lang="ts">
/**
 * A reply's "Thoughts" disclosure. A live reply carries its turn's snapshot; a reply
 * from history only carries `hasTrace`, and its stored trace is fetched the first time
 * it is opened — never with the history itself.
 */
import { computed, ref, watchEffect } from 'vue';
import type { MsgRow } from './transcript-state.js';
import TraceView from './TraceView.vue';
import { loadTrace, traceHasContent, traceLoads, type TraceView as View } from './turn-trace-view.js';

const props = defineProps<{ row: MsgRow }>();

const THOUGHTS = 'Thoughts';
const LOADING = 'Loading…';
const UNAVAILABLE = 'Activity unavailable';
const NO_ACTIVITY = 'No reasoning captured for this turn';

const load = computed(() => (props.row.id ? traceLoads.get(props.row.id) : undefined));

/** Best view known now: the stored trace once fetched, else the live snapshot, else the bare lines. */
const view = computed<View | null>(() => {
  const l = load.value;
  if (l?.status === 'ok') return l.view;
  if (props.row.liveTrace) return props.row.liveTrace;
  const lines = props.row.thoughts ?? [];
  return lines.length
    ? { harness: null, model: null, host: null, durationMs: null, tools: [], notes: [], reasoning: lines, truncated: false }
    : null;
});

const shown = computed(() => traceHasContent(view.value) || (!!props.row.hasTrace && !!props.row.id));

const count = computed(() => {
  const n = view.value?.reasoning.length ?? 0;
  return n ? ` (${n})` : '';
});

const preview = computed(() => {
  const r = view.value?.reasoning ?? [];
  const last = (r[r.length - 1] || '').split('\n').filter(Boolean).pop() || '';
  return last ? ' — ' + (last.length > 90 ? `${last.slice(0, 89)}…` : last) : '';
});

const status = computed(() => {
  const s = load.value?.status;
  if (s === 'loading' && !traceHasContent(view.value)) return LOADING;
  if ((s === 'none' || s === 'error') && !traceHasContent(view.value)) return UNAVAILABLE;
  return '';
});

/**
 * Fetched, but only its header: a turn with no tools, notes or reasoning (most
 * short replies). Without this the panel opened to nothing and read as stuck.
 */
const empty = computed(() => load.value?.status === 'ok' && !traceHasContent(view.value));

const isOpen = ref(false);

function onToggle(e: Event): void {
  isOpen.value = (e.target as HTMLDetailsElement).open;
  // A failed fetch is retried on the next open.
  if (isOpen.value && props.row.hasTrace && props.row.id && load.value?.status === 'error')
    void loadTrace(props.row.id);
}

// Open with nothing cached: fetch. Also covers a trace stored (or re-stored, which
// drops the cached copy) while the panel is already open.
watchEffect(() => {
  if (isOpen.value && props.row.hasTrace && props.row.id && !load.value) void loadTrace(props.row.id);
});
</script>

<template>
  <details v-if="shown" class="thoughts" @toggle="onToggle">
    <summary
      ><svg class="icon" aria-hidden="true"><use href="#i-sparkles"></use></svg
      >{{ ` ${THOUGHTS}${count}` }}<span v-if="preview" class="thoughts-preview">{{ preview }}</span></summary
    >
    <!-- Focusable: it is the scroll container, so the keyboard can scroll a long trace. -->
    <div class="thoughts-body" tabindex="0" :aria-busy="load?.status === 'loading' ? 'true' : undefined">
      <div v-if="status" class="thoughts-line"><span v-if="status === LOADING" class="btn-spinner" aria-hidden="true"></span>{{ status }}</div>
      <TraceView v-if="view && (traceHasContent(view) || empty)" :view="view" />
      <div v-if="empty" class="thoughts-line">{{ NO_ACTIVITY }}</div>
    </div>
  </details>
</template>
