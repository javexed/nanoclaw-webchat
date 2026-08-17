<script setup lang="ts">
/**
 * Skills several agents learned independently — twenty-first island.
 *
 * Mounted into <ul id="skill-duplicates-list">, exclusively owned by this
 * module. The #skill-duplicates wrapper's hidden flag is outside the mount
 * point and stays imperative.
 *
 * The badge here is NOT an OriginBadge. It looks like one and shares its
 * classes, but it is a fixed hue 48 with a count in the label rather than a
 * provenance link — originBadgeProps would compute a hue from the text and
 * change the colour. Kept as literal markup for that reason.
 *
 * `promote.disabled = true` on the clicked element became a pending SET,
 * because there is no clicked element to hold once the row is a vnode and
 * disabling is what stops a double-click promoting twice.
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
