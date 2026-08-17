<script setup lang="ts">
/**
 * The learning-journey timeline — fortieth island.
 *
 * Mounted into <div id="journey-list">, exclusively owned by this module. The
 * filter CONTROLS (#journey-agent-filter, the kind buttons, #journey-skill-chip)
 * live outside it and stay imperative; only the list itself converts.
 *
 * Day headers were emitted inline while appending, using a journeyLastDay
 * variable that persisted across pagination calls. Derived from the full event
 * list here instead — which is why 'Load more' can append to a ref rather than
 * having to remember where the previous page stopped.
 *
 * Visibility is `hidden`, not v-if, exactly as applyJourneyFilters set it: rows
 * stay in the DOM and a day header hides only when every row under it is
 * hidden. #journey-no-match is outside the mount point and driven by the same
 * derived counts.
 */
import { computed } from 'vue';
import { journeyEvents, journeyFilter, journeyPhase } from './journey-state.js';

const props = defineProps<{
  verbs: Record<string, string>;
  meta: (ev: any) => string;
  onOpen: (ev: any) => void;
  onRevert: (ev: any) => void;
}>();

const LOADING = 'Loading…';
const FAILED = 'Could not load the timeline.';
const EMPTY = 'Nothing learned yet.';
const REVERT = 'Revert';

const visible = (ev: any) => {
  const f = journeyFilter.value;
  return (
    (!f.agent || (ev.agentGroupId || '') === f.agent) &&
    (!f.kind || ev.kind === f.kind) &&
    (!f.skill || (ev.skillName || '') === f.skill)
  );
};

/** Events grouped under their day header, in load order. */
const days = computed(() => {
  const now = new Date();
  const out: any[] = [];
  let last = '';
  for (const ev of journeyEvents.value) {
    const d = new Date(ev.ts);
    const day = d.toDateString();
    if (day !== last) {
      last = day;
      out.push({
        key: day,
        label:
          day === now.toDateString()
            ? 'Today'
            : d.toLocaleDateString(
                [],
                d.getFullYear() === now.getFullYear()
                  ? { month: 'long', day: 'numeric' }
                  : { year: 'numeric', month: 'long', day: 'numeric' },
              ),
        rows: [],
      });
    }
    out[out.length - 1].rows.push({
      ev,
      key: `${ev.ts}:${ev.kind}:${ev.skillName}`,
      verb: props.verbs[ev.kind] || ev.kind,
      meta: props.meta(ev),
      time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      linked: (ev.kind === 'kept' || ev.kind === 'revised') && !!ev.skillExists,
    });
  }
  return out;
});

function onKey(e: KeyboardEvent, ev: any) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    props.onOpen(ev);
  }
}
</script>

<template>
  <template v-if="journeyPhase === 'loading'">{{ LOADING }}</template>
  <template v-else-if="journeyPhase === 'error'">{{ FAILED }}</template>
  <div v-else-if="journeyPhase === 'empty'" class="journey-empty">{{ EMPTY }}</div>
  <template v-else>
    <template v-for="d in days" :key="d.key">
      <div class="journey-day" :hidden="d.rows.every((r: any) => !visible(r.ev))">{{ d.label }}</div>
      <div
        v-for="r in d.rows"
        :key="r.key"
        :class="r.linked ? 'journey-row journey-linked' : 'journey-row'"
        :data-kind="r.ev.kind"
        :data-agent="r.ev.agentGroupId || ''"
        :data-skill="r.ev.skillName || ''"
        :hidden="!visible(r.ev)"
        :title="r.ev.description || undefined"
        v-bind="r.linked ? { role: 'button', tabindex: '0' } : {}"
        @click="r.linked ? props.onOpen(r.ev) : undefined"
        @keydown="r.linked ? onKey($event, r.ev) : undefined"
      >
        <span :class="`journey-verb journey-verb-${r.ev.kind}`">{{ r.verb }}</span
        ><span class="journey-skill">{{ r.ev.skillName }}</span
        ><span class="skill-badge skill-badge-scope">{{ r.ev.agentName }}</span
        ><span class="journey-meta">{{ r.meta }}</span
        ><span class="journey-time">{{ r.time }}</span
        ><button
          v-if="r.ev.canRevert"
          type="button"
          class="btn btn-secondary"
          @click.stop="props.onRevert(r.ev)"
        >{{ REVERT }}</button>
      </div>
    </template>
  </template>
</template>
