<script setup lang="ts">
/**
 * The confirm dialog, one app per overlay created by showConfirmModal. `body` may be a
 * string or a live HTMLElement; an element is APPENDED, not rendered, because callers read
 * its value after the promise resolves. No focus trap, unlike the skill editor. Focus goes
 * to Cancel for destructive actions so a stray Enter does not delete.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps<{
  title: string;
  body: any;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  extraActions: Array<{ label: string; className?: string; value: any }>;
  onPick: (result: any) => void;
  onConfirm: () => void;
}>();

const message = ref<HTMLElement | null>(null);
const cancelEl = ref<HTMLButtonElement | null>(null);
const confirmEl = ref<HTMLButtonElement | null>(null);

const isEl = computed(() => props.body instanceof HTMLElement);
const hasBody = computed(() => !!props.body);
const modalClass = computed(() => 'modal confirm-modal' + (props.body ? '' : ' confirm-modal--titleonly'));

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') props.onPick(false);
  // A focused button answers Enter with its own click: Cancel must cancel.
  else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) props.onConfirm();
}

onMounted(() => {
  if (isEl.value && message.value) message.value.appendChild(props.body);
  document.addEventListener('keydown', onKey);
  (props.destructive ? cancelEl.value : confirmEl.value)?.focus();
});
onUnmounted(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <div :class="modalClass">
    <div class="modal-header"><span>{{ title || 'Confirm' }}</span></div>
    <div v-if="hasBody" class="modal-body">
      <div ref="message" class="confirm-message">{{ isEl ? '' : body }}</div>
    </div>
    <div class="confirm-actions">
      <button ref="cancelEl" type="button" class="btn-cancel" @click="props.onPick(false)">{{ cancelLabel }}</button>
      <button
        v-for="a in extraActions"
        :key="a.label"
        type="button"
        :class="a.className || 'btn btn-secondary'"
        @click="props.onPick(a.value)"
      >{{ a.label }}</button>
      <button
        ref="confirmEl"
        type="button"
        :class="destructive ? 'btn btn-danger' : 'btn btn-primary'"
        @click="props.onConfirm()"
      >{{ confirmLabel }}</button>
    </div>
  </div>
</template>
