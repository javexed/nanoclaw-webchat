<script setup lang="ts">
/**
 * A room's skills — thirty-second island.
 *
 * Mounted into <ul id="room-skills-list">, exclusively owned by this module.
 * #room-skills-section (its hidden flag), #room-skills-count and the "Distill a
 * skill" trigger are outside the mount point and stay imperative — the section
 * carries that trigger, which is why it stays visible even when the list is
 * empty.
 *
 * Three row kinds in a fixed order, which is editorial rather than incidental:
 * proposals first, because they are the ones asking for a decision; then what is
 * already wired; then the curator's archive, dimmed and restorable.
 *
 * The proposal row reuses UndoTimer for Keep/Discard, so the pattern matches the
 * drafts island — including measuring the actions element's width BEFORE the
 * swap so the row does not jump.
 */
import { computed } from 'vue';
import OriginBadge from './OriginBadge.vue';
import UndoTimer from './UndoTimer.vue';
import { roomSkillRows, roomSkillUndo, roomSkillsReviewing } from './skills-panel-state.js';

const props = defineProps<{
  undoSeconds: number;
  onView: (id: string) => void;
  onKeep: (row: any) => void;
  onDiscard: (row: any) => void;
  onUndo: (id: string) => void;
  onRevert: (row: any) => void;
  onRemove: (row: any) => void;
  onRestore: (row: any) => void;
}>();

const VIEW = 'View';
const KEEP = 'Keep';
const REVIEWING = 'Reviewing…';
const DISCARD = 'Discard';
const REVERT = 'Revert';
const REVERT_TITLE = 'Back to the previous revision';
const RESTORE = 'Restore';
const ARCHIVED_TAG = 'archived — unused';
const REMOVE_GLYPH = '✕';

const rows = computed(() => roomSkillRows.value);
</script>

<template>
  <template v-for="r in rows" :key="r.key">
    <li v-if="r.kind === 'proposed'" class="room-skill-row proposed">
      <div class="room-skill-head">
        <span class="room-skill-name">{{ r.name }}</span><OriginBadge :origin="r.origin" />
      </div>
      <div class="room-skill-desc">{{ r.desc }}</div>
      <div
        class="room-skill-actions"
        v-bind="roomSkillUndo[r.id]?.width ? { style: { width: roomSkillUndo[r.id].width } } : {}"
      >
        <UndoTimer
          v-if="roomSkillUndo[r.id]"
          :label="roomSkillUndo[r.id].label"
          :seconds="undoSeconds"
          @commit="roomSkillUndo[r.id].commit()"
          @undo="props.onUndo(r.id)"
        />
        <template v-else>
          <button type="button" class="btn btn-ghost" @click="props.onView(r.id)">{{ VIEW }}</button>
          <button
            type="button"
            class="btn btn-primary"
            :title="r.keepTitle"
            :data-draft-id="r.id"
            :disabled="roomSkillsReviewing.has(r.id) || undefined"
            @click="props.onKeep(r)"
          >{{ roomSkillsReviewing.has(r.id) ? REVIEWING : KEEP }}</button>
          <button type="button" class="skill-delete" @click="props.onDiscard(r)">{{ DISCARD }}</button>
        </template>
      </div>
    </li>
    <li v-else-if="r.kind === 'learned'" class="room-skill-row">
      <div class="room-skill-head">
        <span class="room-skill-name">{{ r.name }}</span
        ><OriginBadge v-if="r.origin" :origin="r.origin" /><span v-if="r.who" class="room-skill-agent">{{ r.who }}</span
        ><span v-if="r.uses" class="room-skill-agent">{{ r.uses }}</span
        ><button
          v-if="r.hasHistory"
          type="button"
          class="btn btn-ghost"
          :title="REVERT_TITLE"
          @click="props.onRevert(r)"
        >{{ REVERT }}</button>
      </div>
      <button type="button" class="skill-delete" :title="r.removeTitle" @click="props.onRemove(r)">{{ REMOVE_GLYPH }}</button>
    </li>
    <li v-else class="room-skill-row room-skill-archived">
      <div class="room-skill-head">
        <span class="room-skill-name">{{ r.name }}</span><span class="room-skill-agent">{{ ARCHIVED_TAG }}</span>
      </div>
      <button type="button" class="btn btn-ghost" @click="props.onRestore(r)">{{ RESTORE }}</button>
    </li>
  </template>
</template>
