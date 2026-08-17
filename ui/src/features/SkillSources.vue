<script setup lang="ts">
/**
 * The skill collections list in Settings — twenty-seventh island.
 *
 * Mounted into <ul id="skill-sources-list">, exclusively owned by this module.
 * #settings-skill-sources (the section's owner-only hidden flag) is outside the
 * mount point and stays imperative.
 *
 * Two row kinds share one shape and one template: editable GitHub collections
 * (Edit + Remove) and built-in marketplace sources (a built-in badge and a
 * reversible Add/Remove, since there is no URL to re-paste). The imperative
 * version expressed the shared part as a local sourceRow() helper and then
 * appended different buttons to its result; `kind` selects instead.
 *
 * Each row leads with the same coloured OriginBadge as the pool, so a
 * collection's colour is consistent between Settings and the catalog.
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
