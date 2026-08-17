<script setup lang="ts">
/**
 * The in-room thread switcher — forty-ninth island.
 *
 * Per-instance: openThreadSwitcher creates the popover and mounts an app into
 * it, next to the chat header's '#' button. The sidebar thread tree is hidden on
 * mobile while a room is open, so this is the mobile way to switch threads and
 * create one without backing out.
 *
 * switcherCreate() is absorbed. It did addBtn.replaceWith(input) — replacing a
 * node Vue would own — so the swap is a `creating` ref, and the input is the
 * ThreadNameInput component the room list already uses. blurSubmits stays true:
 * clicking away COMMITS here, which is the prior switcher behaviour and the
 * opposite of the sidebar's inline input.
 *
 * Main chat is always the first row and is never tinted; topic threads carry a
 * dot in their identity colour.
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
