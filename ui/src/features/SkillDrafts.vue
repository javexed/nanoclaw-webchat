<script setup lang="ts">
/**
 * Learned-skill drafts awaiting review, mounted into <ul id="skill-drafts-list">; the
 * #skill-drafts wrapper's hidden flag and the nav badge stay with the renderer. A row
 * renders either its Keep/Discard actions or an UndoTimer, so a re-render mid-countdown
 * is harmless.
 */
import { computed } from 'vue';
import BusyLabel from './BusyLabel.vue';
import UndoTimer from './UndoTimer.vue';
import { draftUndo, draftsReviewing, skillDrafts } from './skills-panel-state.js';

const props = defineProps<{
  undoSeconds: number;
  onOpen: (id: string) => void;
  onSource: (roomId: string) => void;
  onKeep: (draft: any) => void;
  onDiscard: (draft: any) => void;
  onUndo: (id: string) => void;
}>();

const KEEP = 'Keep';
const DISCARD = 'Discard';
const REVIEWING = 'Checking for overlaps…';
const SOURCE = 'from this conversation →';
/** Bound, not a literal space: the compiler condenses whitespace between an interpolation and an element. */
const SPACE = ' ';
/** Amber "learned" — a fixed hue, not derived from the label like OriginBadge. */
const LEARNED_HUE = { '--badge-hue': '48' };

const rows = computed(() =>
  skillDrafts.value.map((d: any) => ({
    id: d.id,
    raw: d,
    name: d.kind === 'patch' ? `${d.targetSkill || d.skillName} (change)` : d.skillName,
    badge: `learned · ${d.agentName}`,
    desc: d.description || '',
    roomId: d.roomId || null,
    keepTitle: `Wire to ${d.agentName}`,
  })),
);
</script>

<template>
  <li v-for="r in rows" :key="r.id" class="skill-row" :data-draft-id="r.id">
    <div class="skill-info" :style="{ cursor: 'pointer' }" @click="props.onOpen(r.id)">
      <div class="skill-head">
        <span class="skill-name">{{ r.name }}</span
        ><span class="skill-badge skill-badge-origin" :style="LEARNED_HUE">{{ r.badge }}</span>
      </div>
      <span class="skill-desc"
        >{{ r.desc }}<template v-if="r.roomId">{{ SPACE }}<a
            href="#"
            class="skill-draft-source"
            @click.stop.prevent="props.onSource(r.roomId)"
          >{{ SOURCE }}</a></template></span
      >
    </div>
    <span class="skill-draft-actions" v-bind="draftUndo[r.id]?.width ? { style: { width: draftUndo[r.id].width } } : {}">
      <UndoTimer
        v-if="draftUndo[r.id]"
        :label="draftUndo[r.id].label"
        :seconds="undoSeconds"
        @commit="draftUndo[r.id].commit()"
        @undo="props.onUndo(r.id)"
      />
      <template v-else>
        <button
          type="button"
          class="btn btn-secondary skill-catalog-add"
          :title="r.keepTitle"
          :data-draft-id="r.id"
          :disabled="draftsReviewing.has(r.id) || undefined"
          @click="props.onKeep(r)"
        ><BusyLabel :busy="draftsReviewing.has(r.id)" :label="KEEP" :busy-label="REVIEWING" /></button>
        <button type="button" class="skill-delete" @click="props.onDiscard(r)">{{ DISCARD }}</button>
      </template>
    </span>
  </li>
</template>
