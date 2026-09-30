<script setup lang="ts">
/**
 * The skill collections list in Settings, mounted into <ul id="skill-sources-list">.
 * `kind` selects between editable GitHub collections (Edit + Remove) and built-in
 * marketplace sources (a built-in badge and a reversible Add/Remove — no URL to
 * re-paste). Rows lead with the same OriginBadge colour as the pool.
 */
import { skillSources } from './skills-panel-state.js';
import OriginBadge from './OriginBadge.vue';

const props = defineProps<{
  onEdit: (row: any) => void;
  onRemove: (row: any) => void;
  onToggleBuiltin: (row: any) => void;
}>();

const EDIT = 'Edit';
const REMOVE = 'Remove';
const ADD = 'Add';
const BUILT_IN = 'built-in';
</script>

<template>
  <li
    v-for="r in skillSources"
    :key="r.key"
    :class="r.disabled ? 'skill-source-row source-disabled' : 'skill-source-row'"
  >
    <div class="skill-info">
      <div class="skill-head"><OriginBadge :origin="r.origin" /></div>
      <span class="skill-desc">{{ r.meta }}</span>
    </div>
    <template v-if="r.kind === 'source'">
      <button type="button" class="btn btn-ghost" @click="props.onEdit(r)">{{ EDIT }}</button>
      <button type="button" class="skill-delete" @click="props.onRemove(r)">{{ REMOVE }}</button>
    </template>
    <template v-else>
      <span class="skill-badge">{{ BUILT_IN }}</span>
      <button
        type="button"
        :class="r.disabled ? 'btn btn-ghost' : 'skill-delete'"
        @click="props.onToggleBuiltin(r)"
      >{{ r.disabled ? ADD : REMOVE }}</button>
    </template>
  </li>
</template>
