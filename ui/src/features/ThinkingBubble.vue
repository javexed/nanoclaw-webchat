<script setup lang="ts">
/**
 * One agent's live thinking bubble.
 *
 * Reproduces ensureThinkingBubble's markup exactly, including the four content
 * divs that were written as one innerHTML string and then addressed
 * individually by four different functions — the verb and target by
 * updateThinkingBubble, the milestone by setThinkingMilestone, the feed by
 * pushReasoning, the fulltrace by renderFullTrace. Those four were the reason
 * this could not be converted on its own: each held a querySelector into a
 * bubble that a component would own.
 *
 * The feed is a BOUNDED TAIL with per-line fade state, not a slice of
 * reasoningLog. pushReasoning kept both — the full log for the expanded trace
 * and the reply's disclosure, and a trimmed DOM buffer for the fading window —
 * and collapsing them would change what the expanded view shows.
 *
 * data-status-live is still rendered even though nothing reads it from the DOM
 * any more — the typing heartbeat reads turn.statusLive now. It stays because
 * the attribute was there before and dropping it would be a markup change
 * smuggled in under a conversion.
 *
 * Feed scroll-follow stays imperative on purpose: it is a scrollTop write on an
 * element Vue owns, which is not a second WRITER (it renders nothing), and
 * there is no declarative way to say "keep the newest line in view".
 */
import { computed, nextTick, watch, useTemplateRef } from 'vue';
import type { ThinkingTurn } from './transcript-state.js';

const props = defineProps<{ turn: ThinkingTurn; onStop: (name: string) => void; onToggle: (name: string) => void }>();

const STOP = 'Stop';
const STOP_TITLE = 'Stop the agent';
const NO_TRACE = 'No reasoning captured for this turn yet.';

const feedEl = useTemplateRef<HTMLElement>('feed');
const traceEl = useTemplateRef<HTMLElement>('trace');

/** Follow the newest line inside the feed's own scroll viewport, and keep the
 *  expanded trace pinned to the bottom — both were scrollTop writes after the
 *  append that produced them. */
watch(
  () => props.turn.feed.length,
  () => void nextTick(() => { if (feedEl.value) feedEl.value.scrollTop = feedEl.value.scrollHeight; }),
);
watch(
  [() => props.turn.reasoningLog.length, () => props.turn.expanded],
  () => void nextTick(() => { if (traceEl.value) traceEl.value.scrollTop = traceEl.value.scrollHeight; }),
);

/** renderFullTrace only ran on expand, so a collapsed bubble's trace div stayed
 *  EMPTY — not merely hidden. Both derivations reproduce that. */
const traceRows = computed(() => (props.turn.expanded ? props.turn.reasoningLog : []));
const traceEmpty = computed(() =>
  props.turn.expanded && !props.turn.reasoningLog.length ? NO_TRACE : '',
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
