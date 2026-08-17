<script setup lang="ts">
/**
 * The skills marketplace pool — thirtieth island.
 *
 * Mounted into <ul id="skills-catalog-list">, exclusively owned by this module.
 *
 * Four list-level states, which the imperative version wrote as four different
 * innerHTML strings into the same element: the wait row, a fetch failure, an
 * empty result, and rows. They are one phase ref, so a failed request cannot
 * leave the previous tier's rows sitting under an error line.
 *
 * The wait and empty copy both change when a search is active, so the query is
 * state too rather than being re-read from the input at render time.
 *
 * The wait row is written out rather than v-html'd from loadingRow(): that
 * helper returns the <li> ITSELF, so v-html would need a wrapper element and
 * produce a nested li. DESIGN.md §5 wants one wait primitive across the app —
 * this is the same markup, and the DOM diff is what holds it to that.
 *
 * The Review link is community-tier only and points at someone else's site, so
 * it keeps target=_blank with rel="noopener noreferrer" — the same treatment
 * OriginBadge gives an outbound URL.
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
