<script setup lang="ts">
/**
 * The in-room thread switcher, one app per popover next to the chat header's '#'
 * button — the mobile way to switch or create threads, since the sidebar tree is hidden
 * there while a room is open. Uses ThreadNameInput with blurSubmits: clicking away
 * COMMITS here, unlike the sidebar's inline input. Main chat is always first and untinted.
 */
import { ref } from 'vue';
import ThreadNameInput from './ThreadNameInput.vue';

const props = defineProps<{
  rows: Array<{ label: string; threadId: string; tinted: boolean; color: string }>;
  currentThread: string;
  onPick: (threadId: string) => void;
  onCreate: (title: string) => void;
  onCancel: () => void;
}>();

const NEW_THREAD = '+ New thread';
const creating = ref(false);
</script>

<template>
  <button
    v-for="r in rows"
    :key="r.threadId"
    :class="r.threadId === currentThread ? 'thread-switcher-item active' : 'thread-switcher-item'"
    type="button"
    role="menuitem"
    @click.stop="props.onPick(r.threadId)"
  >
    <span v-if="r.tinted" class="thread-switcher-dot" :style="{ background: r.color }"></span
    ><span class="thread-switcher-label">{{ r.label }}</span>
  </button>
  <ThreadNameInput
    v-if="creating"
    aria-label="New thread name"
    :blur-submits="true"
    @submit="props.onCreate"
    @cancel="props.onCancel"
  />
  <button v-else class="thread-switcher-item thread-switcher-new" type="button" @click.stop="creating = true">{{ NEW_THREAD }}</button>
</template>
