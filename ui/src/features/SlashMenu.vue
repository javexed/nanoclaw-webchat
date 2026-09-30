<script setup lang="ts">
/**
 * The /command autocomplete, mounted into <div id="slash-menu">. Its hidden flag stays
 * with the caller: every command is admin-only (see command-gate.ts), so non-admins never
 * see the menu. mousedown, NOT click, with preventDefault — the composer's blur would
 * dismiss the menu first (same as MentionPopover).
 */
import { slashActiveIndex, slashRows } from './slash-menu-state.js';

const props = defineProps<{ onPick: (index: number) => void }>();

function pick(e: Event, i: number) {
  e.preventDefault(); // keep focus in the input
  props.onPick(i);
}
</script>

<template>
  <button
    v-for="(c, i) in slashRows"
    :key="c.cmd"
    type="button"
    :class="i === slashActiveIndex ? 'slash-item active' : 'slash-item'"
    role="option"
    @mousedown="pick($event, i)"
  >
    <span class="slash-cmd">{{ c.cmd }}</span><span class="slash-desc">{{ c.desc }}</span>
  </button>
</template>
