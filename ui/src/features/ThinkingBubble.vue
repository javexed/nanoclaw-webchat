<script setup lang="ts">
/**
 * One agent's live thinking bubble. The feed is a bounded tail with per-line fade
 * state, separate from reasoningLog, which the expanded trace and the reply's disclosure
 * show in full. data-status-live is kept for markup stability (the typing heartbeat reads
 * turn.statusLive). Feed scroll-follow is an imperative scrollTop write; it renders nothing.
 */
import { computed, nextTick, watch, useTemplateRef } from 'vue';
import type { ThinkingTurn } from './transcript-state.js';

const props = defineProps<{ turn: ThinkingTurn; onStop: (name: string) => void; onToggle: (name: string) => void }>();

const STOP = 'Stop';
const STOP_TITLE = 'Stop the agent';
const NO_TRACE = 'No reasoning captured for this turn yet.';

const feedEl = useTemplateRef<HTMLElement>('feed');
const traceEl = useTemplateRef<HTMLElement>('trace');

/** Follow the newest line in the feed's viewport; keep the expanded trace pinned to the bottom. */
watch(
  () => props.turn.feed.length,
  () => void nextTick(() => { if (feedEl.value) feedEl.value.scrollTop = feedEl.value.scrollHeight; }),
);
watch(
  [() => props.turn.reasoningLog.length, () => props.turn.expanded],
  () => void nextTick(() => { if (traceEl.value) traceEl.value.scrollTop = traceEl.value.scrollHeight; }),
);

// A collapsed bubble's trace stays empty, not merely hidden. Prefer the untruncated
// blocks when the provider sent them; fall back to the clipped feed lines otherwise.
const traceRows = computed(() =>
  props.turn.expanded ? (props.turn.fullTrace.length ? props.turn.fullTrace : props.turn.reasoningLog) : [],
);
const traceEmpty = computed(() =>
  props.turn.expanded && !props.turn.fullTrace.length && !props.turn.reasoningLog.length ? NO_TRACE : '',
);

function onClick(e: MouseEvent): void {
  // Ignore clicks on links and buttons so selecting text or tapping a link
  // inside does not toggle the trace.
  if ((e.target as Element | null)?.closest('a, button')) return;
  props.onToggle(props.turn.name);
}
</script>

<template>
  <div
    :class="turn.expanded ? 'msg agent thinking-bubble expanded' : 'msg agent thinking-bubble'"
    :data-agent="turn.name"
    v-bind="turn.statusLive ? { 'data-status-live': '1' } : {}"
    @click="onClick"
  >
    <div class="sender">
      <svg class="icon" aria-hidden="true"><use href="#i-bot"></use></svg
      >{{ ` ${turn.name} — ` }}<span class="thinking-verb">{{ turn.verb }}</span
      ><span class="thinking-elapsed">{{ turn.elapsed }}</span
      ><span class="thinking-chevron"
        ><svg class="icon" aria-hidden="true"><use href="#i-chevron-right"></use></svg></span
      ><button
        type="button"
        class="thinking-stop"
        :title="STOP_TITLE"
        :aria-label="STOP_TITLE"
        @click.stop="props.onStop(turn.name)"
      ><span class="stop-square" aria-hidden="true"></span>{{ STOP }}</button>
    </div>
    <div class="bubble">
      <div class="thinking-milestone" :hidden="!turn.milestone">{{ turn.milestone }}</div>
      <div class="thinking-target" :hidden="!turn.detail">{{ turn.detail }}</div>
      <div ref="feed" class="thinking-feed" :hidden="!turn.feed.length">
        <div
          v-for="l in turn.feed"
          :key="l.key"
          :class="l.fading ? 'thinking-feed-line fading' : 'thinking-feed-line'"
        >{{ l.text }}</div>
      </div>
      <div ref="trace" class="thinking-fulltrace">{{ traceEmpty
        }}<div v-for="(l, i) in traceRows" :key="i" class="thinking-fulltrace-line">{{ l }}</div></div>
      <span class="dots"><span></span><span></span><span></span></span>
    </div>
  </div>
</template>
