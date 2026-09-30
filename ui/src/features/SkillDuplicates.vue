<script setup lang="ts">
/**
 * Skills several agents learned independently, mounted into
 * <ul id="skill-duplicates-list">. The badge is literal markup, NOT an OriginBadge: it
 * is a fixed hue 48 with a count, and originBadgeProps would derive the hue from the text.
 * A pending set disables Promote so a double-click cannot promote twice.
 */
import { computed } from 'vue';
import { promotingSkills, skillDuplicates } from './skills-panel-state.js';

const props = defineProps<{ onPromote: (name: string) => void }>();

const PROMOTE = 'Promote';
const DUP_HUE = { '--badge-hue': '48' };

const rows = computed(() =>
  skillDuplicates.value.map((d: any) => ({
    name: d.name,
    badge: `learned · ${d.agents.length} agents`,
    agents: d.agents.join(', '),
  })),
);
</script>

<template>
  <li v-for="r in rows" :key="r.name" class="skill-row">
    <div class="skill-info">
      <div class="skill-head">
        <span class="skill-name">{{ r.name }}</span
        ><span class="skill-badge skill-badge-origin" :style="DUP_HUE">{{ r.badge }}</span>
      </div>
      <span class="skill-desc">{{ r.agents }}</span>
    </div>
    <button
      type="button"
      class="btn btn-secondary skill-catalog-add"
      :disabled="promotingSkills.has(r.name)"
      @click="props.onPromote(r.name)"
    >{{ PROMOTE }}</button>
  </li>
</template>
