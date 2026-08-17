<script setup lang="ts">
/**
 * Agents wired into the open room, with the prime (★) toggle and remove.
 *
 * Mounted into <ul id="room-wired-agents">. The reply-mode info button lives on
 * the label line OUTSIDE this list, so it stays in renderRoomWiredAgents() —
 * an island owns one container, not everything a render function happened to
 * touch.
 *
 * lucide() returns an SVG string, so the two icon buttons bind it with v-html
 * exactly as the imperative version assigned innerHTML. The star has two
 * variants, so it is computed per row rather than hoisted.
 */
import { lucide } from '../core/dom.js';
import { roomWiredRows } from './room-wired-state.js';

const emit = defineEmits<{
  (e: 'prime', agent: any): void;
  (e: 'open', agent: any): void;
  (e: 'remove', agent: any): void;
}>();

const xIcon = lucide('x');
const starIcon = (filled: boolean) => (filled ? lucide('star', 'icon--fill') : lucide('star'));

const primeTitle = (a: any) =>
  a.is_prime
    ? `Stop ${a.name} replying to everything — back to only when @-mentioned`
    : `Make ${a.name} the default — replies to all messages (not just @-mentions)`;

const onlyOne = () => roomWiredRows.value.length <= 1;
</script>

<template>
  <li v-for="agent in roomWiredRows" :key="agent.id">
    <button
      type="button"
      :class="'room-wired-prime' + (agent.is_prime ? ' active' : '')"
      :title="primeTitle(agent)"
      v-html="starIcon(agent.is_prime)"
      @click="emit('prime', agent)"
    ></button>
    <span
      class="room-wired-name room-wired-name-link"
      role="button"
      tabindex="0"
      :title="`Open ${agent.name} settings`"
      @click="emit('open', agent)"
      @keydown.enter.prevent="emit('open', agent)"
      @keydown.space.prevent="emit('open', agent)"
      >{{ agent.name ?? '' }}<span v-if="agent.is_prime" class="room-wired-prime-badge"> default</span></span
    >
    <button
      type="button"
      class="room-wired-remove"
      :title="onlyOne() ? 'Cannot remove the last agent (delete the room instead)' : `Remove ${agent.name}`"
      :disabled="onlyOne()"
      v-html="xIcon"
      @click="emit('remove', agent)"
    ></button>
  </li>
</template>
