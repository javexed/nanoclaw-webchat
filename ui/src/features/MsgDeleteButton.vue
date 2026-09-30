<script setup lang="ts">
/**
 * The 🗑 on your own messages, with its two-step confirm. The 3-second confirm timer is
 * per-instance and cleared on unmount, since the button can outlive its confirm window if
 * the transcript re-renders under it.
 */
import { onUnmounted, ref } from 'vue';
import { state } from '../core/state.js';

const props = defineProps<{ messageId: string }>();

const TRASH = '🗑';
const CONFIRM = 'delete?';
const TITLE = 'Delete message';

const confirming = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});

function click(): void {
  if (confirming.value) {
    if (timer) clearTimeout(timer);
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'delete_message', message_id: props.messageId }));
    }
    return;
  }
  confirming.value = true;
  timer = setTimeout(() => {
    confirming.value = false;
  }, 3000);
}
</script>

<template>
  <button :class="confirming ? 'msg-delete confirm' : 'msg-delete'" :title="TITLE" @click.stop="click">{{
    confirming ? CONFIRM : TRASH
  }}</button>
</template>
