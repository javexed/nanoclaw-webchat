<script setup lang="ts">
/**
 * Skills available to the open agent, with per-skill enable toggles; mounted into
 * <ul id="agent-skills-list">. The checkboxes are uncontrolled: saveAgentSkills() reads
 * the property from the DOM, so a controlled ref would change what Save sends. The
 * `checked` attribute Vue also emits is inert, since nothing resets the form.
 */
import { agentSkillRows, agentSkillsEnabled } from './agent-skills-state.js';

const emit = defineEmits<{ (e: 'view', name: string): void; (e: 'dirty'): void }>();

const EMPTY = 'No skills available in this install';
</script>

<template>
  <li v-if="agentSkillRows.length === 0" class="agent-mcp-empty">{{ EMPTY }}</li>
  <template v-else>
    <li v-for="s in agentSkillRows" :key="s.name" class="agent-skill-row">
      <div
        class="agent-mcp-info"
        :style="{ cursor: 'pointer' }"
        role="button"
        tabindex="0"
        title="View skill details"
        @click="emit('view', s.name)"
        @keydown.enter.prevent="emit('view', s.name)"
        @keydown.space.prevent="emit('view', s.name)"
      >
        <span class="agent-mcp-name">{{ s.name ?? '' }}</span>
        <span class="agent-mcp-meta">{{ s.description || '' }}</span>
      </div>
      <input
        type="checkbox"
        class="agent-skill-toggle"
        .checked="agentSkillsEnabled.has(s.name)"
        :data-skill="s.name"
        :aria-label="`Enable skill ${s.name}`"
        @change="emit('dirty')"
      />
    </li>
  </template>
</template>
