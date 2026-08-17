<script setup lang="ts">
/**
 * The 🎓 learn menu — forty-first island.
 *
 * Mounted into <div id="learn-menu">, exclusively owned by this module. The
 * #learn-btn trigger and its aria-expanded stay imperative — outside the mount
 * point.
 *
 * Three fixed actions, then ONE pair of room-scoped toggles. One pair, not one
 * per agent: the room layer overrides the wired agents' defaults, so many
 * agents never means many switches.
 *
 * aria-checked binds the BOOLEAN. Vue renders aria-* false as the string
 * "false" rather than dropping the attribute, which is what the imperative
 * setAttribute(…, String(!!on)) produced — verified in the diff, not assumed.
 *
 * The toggles are menuitemcheckbox rows whose state text doubles as the value —
 * the imperative version read `state.textContent !== 'on'` to decide the next
 * value. That is a ref here, but the optimistic rule is preserved exactly: the
 * row only flips once the write comes back true.
 */
import { learnAutoKeep, learnAutoTrigger, learnTogglesVisible } from './learn-menu-state.js';

const props = defineProps<{
  onSession: () => void;
  onLink: () => void;
  onFolder: () => void;
  onAutoTrigger: (on: boolean) => void;
  onAutoKeep: (on: boolean) => void;
}>();

const ITEMS = [
  { icon: 'i-sparkles', label: 'This session', key: 'session' },
  { icon: 'i-link', label: 'From a link…', key: 'link' },
  { icon: 'i-folder', label: 'From a folder…', key: 'folder' },
] as const;

const AUTO_TRIGGER = 'Auto-distill busy turns (this room)';
const AUTO_KEEP = 'Auto-keep drafts (this room)';

function fire(key: string) {
  if (key === 'session') props.onSession();
  else if (key === 'link') props.onLink();
  else props.onFolder();
}
</script>

<template>
  <button
    v-for="it in ITEMS"
    :key="it.key"
    type="button"
    class="learn-menu-item"
    role="menuitem"
    @click="fire(it.key)"
  >
    <svg class="icon" aria-hidden="true"><use :href="`#${it.icon}`"></use></svg><span class="learn-menu-key">{{ it.label }}</span>
  </button>
  <template v-if="learnTogglesVisible">
    <button
      type="button"
      class="learn-menu-item"
      role="menuitemcheckbox"
      :aria-checked="learnAutoTrigger"
      @click="props.onAutoTrigger(!learnAutoTrigger)"
    >
      <span>{{ AUTO_TRIGGER }}</span
      ><span :class="learnAutoTrigger ? 'learn-menu-state on' : 'learn-menu-state'">{{ learnAutoTrigger ? 'on' : 'off' }}</span>
    </button>
    <button
      type="button"
      class="learn-menu-item"
      role="menuitemcheckbox"
      :aria-checked="learnAutoKeep"
      @click="props.onAutoKeep(!learnAutoKeep)"
    >
      <span>{{ AUTO_KEEP }}</span
      ><span :class="learnAutoKeep ? 'learn-menu-state on' : 'learn-menu-state'">{{ learnAutoKeep ? 'on' : 'off' }}</span>
    </button>
  </template>
</template>
