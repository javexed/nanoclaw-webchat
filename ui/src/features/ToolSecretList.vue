<script setup lang="ts">
/**
 * Workspace-scoped tool secrets — fifty-seventh island.
 *
 * Mounted into <ul id="secrets-list">, exclusively owned by this module.
 *
 * Every row is 'shared' — this list IS the workspace scope, so unlike
 * AgentSecretList there is no personal/shared distinction to draw and no owner
 * to name. Two lists, two islands, because they answer different questions.
 *
 * loadToolSecretList takes a listSel parameter, but the only selector that ever
 * reaches it is this one: removeToolSecret routes an agent-scoped delete to
 * renderAgentSecrets instead, which repaints the other island. Checked rather
 * than assumed — a second writer into a Vue-owned list is exactly the bug this
 * phase keeps finding.
 */
import { toolSecretRows } from './tool-secrets-state.js';

const props = defineProps<{ onRemove: (secret: any) => void }>();

const EMPTY = 'No system secrets';
const SHARED = 'shared';
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
