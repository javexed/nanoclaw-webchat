<script setup lang="ts">
/**
 * An agent's own scoped skills, mounted into <ul id="agent-scoped-list">. The badge
 * renders only when origin.label is truthy — origin can be present but empty.
 */
import { computed } from 'vue';
import OriginBadge from './OriginBadge.vue';
import { agentScopedSkills } from './skills-panel-state.js';

const props = defineProps<{
  onOpen: (name: string) => void;
  onRemove: (name: string, el: HTMLElement) => void;
}>();

const EMPTY = 'None yet — import one below (this agent only).';
const REMOVE = 'Remove';
const OPEN_TITLE = 'View / edit this skill';
const CLICKABLE = { cursor: 'pointer' };

const rows = computed(() =>
  agentScopedSkills.value.map((s: any) => ({
    name: s.name ?? '',
    desc: s.description || '',
    origin: s.origin && s.origin.label ? s.origin : null,
  })),
);

function onKey(e: KeyboardEvent, name: string) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    props.onOpen(name);
  }
}
</script>

<template>
  <li v-if="rows.length === 0" class="agent-mcp-empty">{{ EMPTY }}</li>
  <li v-for="r in rows" :key="r.name" class="agent-skill-row">
    <div
      class="agent-mcp-info"
      :style="CLICKABLE"
      role="button"
      tabindex="0"
      :title="OPEN_TITLE"
      @click="props.onOpen(r.name)"
      @keydown="onKey($event, r.name)"
    >
      <div class="skill-head">
        <span class="agent-mcp-name">{{ r.name }}</span
        ><OriginBadge v-if="r.origin" :origin="r.origin" />
      </div>
      <span class="agent-mcp-meta">{{ r.desc }}</span>
    </div>
    <button type="button" class="skill-delete" @click="props.onRemove(r.name, $event.currentTarget as HTMLElement)">{{ REMOVE }}</button>
  </li>
</template>
