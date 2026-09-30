<script setup lang="ts">
/**
 * Suggested skills on the agent-create form, mounted into <ul id="agent-create-skills-list">.
 * The checkboxes keep their state in the DOM and carry data-url/data-name because the
 * create-agent submit reads them there; a missed reader would fail silently (an agent
 * created without the skills you ticked).
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
