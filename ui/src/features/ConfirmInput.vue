<script setup lang="ts">
/**
 * The text field showConfirmModal borrows as its body — sixty-fourth island.
 *
 * Per-instance, like the skill editor and the confirm modal itself: one app per
 * call, mounted into the detached wrapper that is then handed to
 * showConfirmModal as `body`. The modal's element-body contract is unchanged;
 * only what fills that element is Vue now.
 *
 * State comes through provide(), NOT props. Root props are read once at
 * createApp and never update, and two of these can be open at once in principle
 * — a module ref would make the second overwrite the first. The injected object
 * is created per call, so instances cannot collide.
 *
 * The input is UNCONTROLLED: no v-model, no :value. The caller reads
 * input.value at confirm time, exactly as before. v-model would attach an input
 * listener the original only attached when a validator was supplied, and
 * :value would emit a value="" attribute that the imperative .value assignment
 * never produced (type=text is IDL "value" mode — it does not reflect; a radio
 * would, see #244). The element is captured through a function ref so the
 * caller still has the handle it reads.
 *
 * The @input handler is conditional for the same reason: without a validator
 * the original bound nothing at all — hence v-on with an empty object rather
 * than a handler that checks and does nothing, which would still bind.
 *
 * One accepted markup difference, in the NO-VALIDATOR case only: v-if leaves
 * its anchor comment behind, so the wrapper holds <input><!----> where the
 * imperative version held <input>. With a validator both render the error div
 * and there is no anchor, which is why only one of the four probed states
 * differs.
 *
 * The alternatives are all worse than an invisible comment node: v-show would
 * add a real element with a style attribute in the case that had none, always
 * rendering it adds an element outright, and splitting into two components to
 * dodge the anchor duplicates the markup this is meant to unify. Same call as
 * data-v-app on every mount host.
 */
import { inject } from 'vue';

const s = inject<any>('confirmInput');

function capture(el: any): void {
  if (!el) return;
  s.el = el;
  el.value = s.initial;
}

function onInput(): void {
  s.error = '';
  s.invalid = false;
}
</script>

<template>
  <input
    type="text"
    class="confirm-input"
    :class="s.invalid ? 'invalid' : undefined"
    :placeholder="s.placeholder"
    autocomplete="off"
    :ref="capture"
    v-on="s.validate ? { input: onInput } : {}"
  />
  <div v-if="s.validate" class="confirm-input-error" :hidden="!s.error">{{ s.error }}</div>
</template>
