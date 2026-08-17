<script setup lang="ts">
/**
 * An in-transcript skill-draft card — thirty-third island, and the first
 * PER-INSTANCE one.
 *
 * Every other island owns a container that exists in index.html. This one is
 * appended into #messages, which the transcript owns imperatively — so instead
 * of one app for a list, each card gets its own app mounted into the wrapper
 * skills.ts creates. The transcript keeps owning #messages; Vue owns only the
 * inside of that one div.
 *
 * That is the shape transcript.ts will need when it converts, so it is worth
 * establishing here on 79 lines rather than discovering it on 210.
 *
 * The undo countdown and the Reviewing… flag live in module state keyed by
 * draft id, NOT in props. A root app's props are read once — they are not
 * reactive — so a prop would freeze at mount and the timer would never appear.
 * Every other island already reads its changing state this way; doing it
 * differently here to work around per-instance mounting would have meant
 * $forceUpdate, which is the wrong precedent to set for transcript.ts.
 *
 * Resolved cards collapse to a one-line note. The card form carries the same
 * View/Keep/Discard trio as the room-skills proposal row, and the same
 * UndoTimer.
 */
import UndoTimer from './UndoTimer.vue';
import OriginBadge from './OriginBadge.vue';
import { cardReviewing, cardUndo } from './skills-panel-state.js';

const props = defineProps<{
  title: string;
  resolved: boolean;
  status: string;
  agentName: string;
  desc: string;
  undoSeconds: number;
  draftId: string;
  onView: () => void;
  onKeep: () => void;
  onDiscard: () => void;
  onUndo: () => void;
}>();

const VIEW = 'View';
const KEEP = 'Keep';
const REVIEWING = 'Reviewing…';
const DISCARD = 'Discard';
</script>

<template>
  <div v-if="resolved" class="approval-inroom-note resolved">
    {{ status === 'kept' ? `✅ ${title} — kept` : `🗑 ${title} — discarded` }}
  </div>
  <div v-else class="skill-draft-card">
    <div class="skill-head">
      <span class="skill-name">{{ title }}</span
      ><OriginBadge v-if="agentName" :origin="{ label: `learned · ${agentName}`, official: false }" />
    </div>
    <div class="skill-desc">{{ desc }}</div>
    <div class="skill-draft-actions" v-bind="cardUndo[draftId]?.width ? { style: { width: cardUndo[draftId].width } } : {}">
      <UndoTimer
        v-if="cardUndo[draftId]"
        :label="cardUndo[draftId].label"
        :seconds="undoSeconds"
        @commit="cardUndo[draftId].commit()"
        @undo="props.onUndo()"
      />
      <template v-else>
        <button type="button" class="btn btn-ghost" @click="props.onView()">{{ VIEW }}</button>
        <button
          type="button"
          class="btn btn-primary"
          :title="`Wire to ${agentName}`"
          :data-draft-id="draftId"
          :disabled="cardReviewing.has(draftId) || undefined"
          @click="props.onKeep()"
        >{{ cardReviewing.has(draftId) ? REVIEWING : KEEP }}</button>
        <button type="button" class="skill-delete" @click="props.onDiscard()">{{ DISCARD }}</button>
      </template>
    </div>
  </div>
</template>
