<script setup lang="ts">
/**
 * The wizard's Ollama model radios, mounted into <ul id="wizard-ollama-list">.
 * No @change: the listener is delegated on the host, which Vue never replaces. The
 * checked radio is state because two paths select one (that listener and the post-pull
 * path). `value` and `checked` are assigned as properties through a function ref — the
 * faithful choice for every input type — and the arrow is recreated each render so the
 * properties follow the selection.
 */
import { wizardOllamaModels, wizardOllamaSelected } from './wizard-state.js';

function apply(el: any, m: string): void {
  if (!el) return;
  el.value = m;
  el.checked = m === wizardOllamaSelected.value;
}
</script>

<template>
  <li v-for="m in wizardOllamaModels" :key="m">
    <label
      ><input type="radio" name="wizard-ollama-model" :ref="(el) => apply(el, m)" /><span>{{
        m
      }}</span></label
    >
  </li>
</template>
