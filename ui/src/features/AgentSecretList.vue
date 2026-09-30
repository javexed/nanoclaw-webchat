<script setup lang="ts">
/**
 * An agent's tool secrets, mounted into <ul id="agent-secrets-list">, grouped by REACH,
 * nearest first: yours, this agent's shared, all-agents, then other people's own. Those
 * last are listed so an admin can see who holds a key, but carry no Remove — only their
 * owner may touch them, and a button the server refuses is worse than none.
 */
import { computed } from 'vue';

import { agentSecretEffective, agentSecretRows, type SecretReach } from './agent-lists-state.js';

const props = defineProps<{ onRemove: (row: { scope: unknown; sec: unknown }) => void }>();

const REMOVE = 'Remove';
const EMPTY = 'No secrets yet';
const SECTIONS: Array<{ reach: SecretReach; title: string }> = [
  { reach: 'mine', title: 'Only you' },
  { reach: 'agent', title: 'Everyone on this agent' },
  { reach: 'workspace', title: 'All agents' },
  { reach: 'other', title: 'Other people (read-only)' },
];
const MINE = 'only you';

const sections = computed(() =>
  SECTIONS.map((s) => ({ ...s, rows: agentSecretRows.value.filter((r) => r.reach === s.reach) })).filter(
    (s) => s.rows.length > 0,
  ),
);
</script>

<template>
  <li v-if="agentSecretEffective" class="secret-effective">{{ agentSecretEffective }}</li>
  <li v-if="sections.length === 0" class="skill-desc">{{ EMPTY }}</li>
  <template v-for="s in sections" :key="s.reach">
    <li class="secret-section-head">{{ s.title }}</li>
    <li v-for="r in s.rows" :key="r.key" class="skill-source-row secret-row">
      <div class="skill-info">
        <div class="skill-head">
          <span>{{ r.host }}</span
          ><span v-if="r.reach === 'other'" class="skill-badge secret-scope">{{ r.ownerLabel }}</span
          ><span v-else-if="r.reach === 'mine'" class="skill-badge secret-scope skill-badge-user">{{ MINE }}</span>
        </div>
        <span v-if="r.note" class="skill-desc">{{ r.note }}</span>
      </div>
      <button v-if="r.canRemove" class="btn btn-danger" type="button" @click="props.onRemove(r)">{{ REMOVE }}</button>
    </li>
  </template>
</template>
