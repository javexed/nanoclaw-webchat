<script setup lang="ts">
/**
 * The inline thread-name input, for "new thread" and rename. `settled` guards the
 * Enter/blur pair: blur fires after Enter, so without it a submit is followed by a cancel
 * (or, with blurSubmits, a second submit). A placeholder is set only when there is no
 * initial value.
 */
import { onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    value?: string;
    placeholder?: string;
    ariaLabel?: string;
    selectAll?: boolean;
    blurSubmits?: boolean;
  }>(),
  { value: '', placeholder: 'Thread name…', selectAll: false, blurSubmits: false },
);

const emit = defineEmits<{ (e: 'submit', title: string): void; (e: 'cancel'): void }>();

const el = ref<HTMLInputElement | null>(null);
let settled = false;

function cancel() {
  if (settled) return;
  settled = true;
  emit('cancel');
}

function submit() {
  if (settled) return;
  const title = el.value?.value.trim() ?? '';
  // empty or unchanged → cancel
  if (!title || title === props.value) return cancel();
  settled = true;
  emit('submit', title);
}

function onKey(e: KeyboardEvent) {
  e.stopPropagation();
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  }
}

onMounted(() => {
  // setTimeout, not nextTick: a full task defers focus until the row is in the
  // document and laid out.
  setTimeout(() => {
    el.value?.focus();
    if (props.selectAll) el.value?.select();
  }, 0);
});
</script>

<template>
  <input
    ref="el"
    type="text"
    class="thread-add-input"
    maxlength="80"
    v-bind="value ? { value } : { placeholder }"
    :aria-label="ariaLabel"
    @click.stop
    @keydown="onKey"
    @blur="blurSubmits ? submit() : cancel()"
  />
</template>
