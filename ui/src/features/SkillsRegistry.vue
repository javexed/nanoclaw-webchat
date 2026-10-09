<script setup lang="ts">
/**
 * The skills registry, mounted into <ul id="skills-list">. Available updates are state,
 * never buttons injected after render; Update precedes Remove. Visibility is `hidden`, not
 * v-if, because the filter counts matches from rows that stay in the DOM. An active filter
 * owns expansion, and a section with no matches hides its header.
 */
import { computed } from 'vue';
import BusyLabel from './BusyLabel.vue';
import OriginBadge from './OriginBadge.vue';
import {
  skillSections,
  skillUpdates,
  skillUpdating,
  skillsFilter,
  skillsOpenSections,
  skillsPhase,
} from './skills-panel-state.js';

const props = defineProps<{
  onOpen: (row: any) => void;
  onToggleSection: (key: string) => void;
  onDelete: (row: any) => void;
  onHistory: (row: any) => void;
  onUpdate: (name: string) => void;
}>();

const LOADING = 'Loading…';
const EMPTY = 'No skills yet — import one above.';
const NO_MATCH = 'No matching skills';
const REMOVE = 'Remove';
const HISTORY = 'History';
const UPDATE = 'Update';
const UPDATING = 'Updating…';
const UPDATE_TITLE = 'The source repo has newer commits — re-import from it';
const CHEVRON = '›';

/** Per section: which rows show, and whether the header itself shows. */
const view = computed(() => {
  const q = skillsFilter.value;
  return skillSections.value.map((s) => {
    const shown = q ? s.rows.filter((r) => r.search.includes(q)).length : 0;
    const open = q ? shown > 0 : skillsOpenSections.value.has(s.key);
    return {
      ...s,
      open,
      headHidden: q ? shown === 0 : false,
      rowHidden: (r: any) => (q ? !r.search.includes(q) : !skillsOpenSections.value.has(s.key)),
    };
  });
});

const anyMatch = computed(() => !!skillsFilter.value && view.value.some((s) => !s.headHidden));
</script>

<template>
  <li v-if="skillsPhase === 'loading'" class="skills-empty"><span class="btn-spinner" aria-hidden="true"></span>{{ LOADING }}</li>
  <li v-else-if="skillsPhase === 'empty'" class="skills-empty">{{ EMPTY }}</li>
  <template v-else>
    <template v-for="s in view" :key="s.key">
      <li
        :class="s.open ? 'skills-section-head open' : 'skills-section-head'"
        :data-section-head="s.key"
        :hidden="s.headHidden"
        role="button"
        tabindex="0"
        :aria-expanded="s.open ? 'true' : 'false'"
        @click="props.onToggleSection(s.key)"
        @keydown="
          (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              props.onToggleSection(s.key);
            }
          }
        "
      >
        <span class="skills-section-chevron">{{ CHEVRON }}</span
        ><span class="skills-section-label">{{ s.label }}</span
        ><span v-if="s.roomName" class="skill-badge skill-badge-scope">{{ s.roomName }}</span
        ><span class="skills-section-count">{{ s.rows.length }}</span>
      </li>
      <li
        v-for="r in s.rows"
        :key="r.key"
        class="skill-row"
        v-bind="r.source === 'user' ? { 'data-skill': r.name } : {}"
        :data-section="s.key"
        :data-search="r.search"
        :hidden="s.rowHidden(r)"
      >
        <div
          class="skill-info"
          :style="{ cursor: 'pointer' }"
          role="button"
          tabindex="0"
          @click="props.onOpen(r)"
          @keydown="
            (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                props.onOpen(r);
              }
            }
          "
        >
          <div class="skill-head">
            <span class="skill-name">{{ r.name }}</span
            ><OriginBadge v-if="r.badge.kind === 'origin'" :origin="r.badge.origin" /><span
              v-else
              :class="
                r.badge.kind === 'scope'
                  ? 'skill-badge skill-badge-scope'
                  : r.badge.kind === 'shipped'
                    ? 'skill-badge'
                    : 'skill-badge skill-badge-user'
              "
              >{{ r.badge.text }}</span
            ><OriginBadge v-if="r.extraOrigin" :origin="r.extraOrigin" />
          </div>
          <span class="skill-desc">{{ r.desc }}</span>
        </div>
        <template v-if="r.source === 'user'">
          <button
            v-if="skillUpdates[r.name]"
            type="button"
            class="btn btn-secondary skill-update-btn"
            :title="UPDATE_TITLE"
            :disabled="skillUpdating.has(r.name) || undefined"
            @click="props.onUpdate(r.name)"
          ><BusyLabel :busy="skillUpdating.has(r.name)" :label="UPDATE" :busy-label="UPDATING" /></button
          ><button type="button" class="skill-delete" @click="props.onDelete(r)">{{ REMOVE }}</button>
        </template>
        <template v-else-if="r.source === 'scoped'">
          <button type="button" class="btn btn-ghost skill-history-btn" @click="props.onHistory(r)">{{ HISTORY }}</button>
          <button type="button" class="skill-delete" @click="props.onDelete(r)">{{ REMOVE }}</button>
        </template>
      </li>
    </template>
    <li id="skills-no-match" class="skills-empty" :hidden="!skillsFilter || anyMatch">{{ NO_MATCH }}</li>
  </template>
</template>
