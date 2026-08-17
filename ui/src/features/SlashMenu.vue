<script setup lang="ts">
/**
 * The /command autocomplete — forty-eighth island.
 *
 * Mounted into <div id="slash-menu">, exclusively owned by this module. Its
 * hidden flag stays imperative: the menu is suppressed for non-admins entirely
 * (every one of these commands is admin-only — see command-gate.ts), and
 * whether to show it at all is a decision about the surface, not the rows.
 *
 * mousedown, NOT click, with preventDefault — the composer's blur would dismiss
 * the menu before a click could land, and preventing default keeps focus in the
 * input. Same reason MentionPopover uses it.
 *
 * esc() is gone: the imperative version built the row with innerHTML, so the
 * command and description had to be escaped by hand. Bindings escape by
 * construction.
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
