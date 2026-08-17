<script setup lang="ts">
/**
 * The 🗑 on your own messages, with its two-step confirm.
 *
 * createDeleteButton() held the confirm in the ELEMENT — a class, a label swap
 * and a 3-second timer closed over the button — which is fine for a node nobody
 * else owns and impossible once the message is Vue-rendered.
 *
 * The timer is per-instance rather than keyed state: only one button can be
 * mid-confirm at a time in practice, but nothing enforced that before either,
 * and a component instance is exactly the scope the closure had.
 *
 * onUnmounted clears it. The old button was garbage with its message; this one
 * can outlive its confirm window if the transcript re-renders under it.
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
