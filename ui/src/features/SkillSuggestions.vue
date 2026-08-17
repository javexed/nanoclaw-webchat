<script setup lang="ts">
/**
 * Suggested skills on the agent-create form — thirty-first island.
 *
 * Mounted into <ul id="agent-create-skills-list">, exclusively owned by this
 * module. The #agent-create-skills block's hidden flag is outside the mount
 * point and stays imperative — it hides the heading too, not just the list.
 *
 * The checkboxes keep their state in the DOM and carry data-url/data-name,
 * because the create-agent submit reads them with querySelectorAll and pulls
 * both off the dataset. Same contract as the two agent pickers: modelling the
 * selection as a ref would mean changing a reader elsewhere, and the failure
 * mode is silent — an agent created with none of the skills you ticked.
 */
import { skillSuggestions } from './skills-panel-state.js';

const AVAILABLE = 'available';
</script>

<template>
  <li v-for="s in skillSuggestions" :key="s.name" class="agent-create-skill-row">
    <div class="skill-info">
      <div class="skill-head"><span class="skill-name">{{ s.name ?? '' }}</span></div>
      <span class="skill-desc">{{ s.description || '' }}</span>
    </div>
    <span v-if="s.source === 'installed'" class="skill-badge">{{ AVAILABLE }}</span>
    <input
      v-else
      type="checkbox"
      class="agent-create-skill-check"
      :data-url="s.url"
      :data-name="s.name"
      :aria-label="`Add skill ${s.name} (${s.source})`"
    />
  </li>
</template>
