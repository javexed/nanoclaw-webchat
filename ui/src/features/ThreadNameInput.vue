<script setup lang="ts">
/**
 * The inline thread-name input — used for "new thread" and for rename.
 *
 * Replaces makeThreadNameInput(), which built the element imperatively and was
 * appended into three different places. Rendered by ThreadRows now.
 *
 * `settled` is the load-bearing part and is preserved exactly: blur fires after
 * Enter, so without it a submit is followed immediately by a cancel — or, with
 * blurSubmits, by a second submit. It guards the pair, not each handler.
 *
 * `value` and `placeholder` are mutually exclusive, as before: the imperative
 * version set placeholder ONLY when there was no initial value, so a rename
 * input carries no placeholder attribute at all.
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
  // setTimeout, not nextTick: the imperative version deferred a full task so
  // focus lands after the row it sits in is in the document and laid out.
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
