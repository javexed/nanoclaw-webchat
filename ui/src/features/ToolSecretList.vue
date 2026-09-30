<script setup lang="ts">
/**
 * Workspace-scoped tool secrets, mounted into <ul id="secrets-list">. Every row is
 * 'shared' — this list IS the workspace scope. Agent-scoped deletes repaint
 * AgentSecretList instead, so this list has one writer.
 */
import { toolSecretRows } from './tool-secrets-state.js';

const props = defineProps<{ onRemove: (secret: any) => void }>();

const EMPTY = 'No all-agents secrets yet';
const SHARED = 'all agents';
const REMOVE = 'Remove';
</script>

<template>
  <li v-if="toolSecretRows.length === 0" class="skill-desc">{{ EMPTY }}</li>
  <li v-for="(s, i) in toolSecretRows" :key="i" class="skill-source-row secret-row">
    <div class="skill-info">
      <div class="skill-head">
        <span>{{ s.hostPattern }}</span><span class="skill-badge secret-scope">{{ SHARED }}</span>
      </div>
    </div>
    <button class="btn btn-danger" type="button" @click="props.onRemove(s)">{{ REMOVE }}</button>
  </li>
</template>
