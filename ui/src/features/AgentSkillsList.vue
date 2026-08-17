<script setup lang="ts">
/**
 * Skills available to the open agent, with per-skill enable toggles.
 *
 * Mounted into <ul id="agent-skills-list">. The fetch, the count badge, the
 * scoped-skills sub-list and the Save button all stay in renderAgentSkills().
 *
 * Known, accepted DOM difference: Vue emits a `checked` ATTRIBUTE on the
 * enabled boxes; the imperative version assigned only the PROPERTY, which does
 * not serialise. Both the .prop modifier and a plain :checked bind produce the
 * attribute, so this is Vue's rendering, not a template mistake.
 *
 * Inert here, and checked rather than assumed: the property is correct on every
 * row (verified in-browser), saveAgentSkills() reads the property, and nothing
 * in this UI resets the form — which is the only path where the attribute's
 * defaultChecked meaning would diverge.
 *
 * The checkbox is UNCONTROLLED on purpose: the binding sets initial state and
 * nothing binds it back. saveAgentSkills() reads the boxes out of the DOM, so
 * making them controlled would require re-implementing that read against a ref
 * for no gain — and would silently change what Save sends.
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
