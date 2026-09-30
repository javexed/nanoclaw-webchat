<script setup lang="ts">
/**
 * The skills marketplace pool, mounted into <ul id="skills-catalog-list">. Its four
 * states (wait, error, empty, rows) are one phase ref, so a failed request cannot leave
 * stale rows under an error line. The wait row matches loadingRow()'s markup (DESIGN.md
 * §5). Community Review links are outbound, so they keep rel="noopener noreferrer".
 */
import { computed } from 'vue';
import OriginBadge from './OriginBadge.vue';
import { skillPool, skillPoolCommunity, skillPoolPhase, skillPoolQuery } from './skills-panel-state.js';

const props = defineProps<{ onAdd: (row: any) => void }>();

const FAILED = 'Couldn’t load skills — import by URL below.';
const REVIEW = 'Review ↗';
const ADDED = 'added';
const ADD = 'Add';

const waitLabel = computed(() => (skillPoolQuery.value ? 'Searching…' : 'Loading skills…'));
const emptyLabel = computed(() => (skillPoolQuery.value ? 'No matches.' : 'Nothing here yet.'));
</script>

<template>
  <li v-if="skillPoolPhase === 'loading'" class="skills-empty">
    <span class="btn-spinner" aria-hidden="true"></span>{{ waitLabel }}
  </li>
  <li v-else-if="skillPoolPhase === 'error'" class="skills-empty">{{ FAILED }}</li>
  <li v-else-if="skillPoolPhase === 'empty'" class="skills-empty">{{ emptyLabel }}</li>
  <template v-else>
    <li v-for="s in skillPool" :key="s.name" class="skill-row">
      <div class="skill-info">
        <div class="skill-head">
          <span class="skill-name">{{ s.name ?? '' }}</span><OriginBadge :origin="s.origin" />
        </div>
        <span class="skill-desc">{{ s.description || '' }}</span>
      </div>
      <a
        v-if="skillPoolCommunity && s.review"
        class="skill-review"
        :href="s.review"
        target="_blank"
        rel="noopener noreferrer"
      >{{ REVIEW }}</a>
      <span v-if="s.installed" class="skill-badge skill-badge-user">{{ ADDED }}</span>
      <button v-else type="button" class="btn btn-secondary skill-catalog-add" @click="props.onAdd(s)">{{ ADD }}</button>
    </li>
  </template>
</template>
