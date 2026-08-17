<script setup lang="ts">
/**
 * The wizard's Ollama model radios — sixty-second island.
 *
 * Mounted into <ul id="wizard-ollama-list">, exclusively owned by this module.
 * Everything else wizardProbeOllama touches — the status line, the results and
 * download rows, the probe button's busy label — is SET on static markup and
 * stays imperative. Only the radio list was built.
 *
 * No @change here, deliberately. The listener is delegated on the HOST, which
 * Vue never replaces, so it keeps working across every render and the listener
 * set is unchanged by this conversion. Putting @change on each input would add
 * one listener per model and remove the host's — a diff for no gain.
 *
 * The checked radio is state because TWO paths select one: that delegated
 * listener, and the post-pull path, which used to find the input with
 * querySelector and assign .checked on it — an imperative write into what is
 * now Vue-owned DOM.
 *
 * Both `value` and `checked` are assigned as PROPERTIES through a function ref.
 * Only one of them had to be — measured, not assumed:
 *
 *   radio.value = v      → value="v"      REFLECTS
 *   radio.checked = true → no attribute   does not reflect
 *   text.value = v       → no attribute   does not reflect
 *   button.disabled      → disabled=""    REFLECTS
 *
 * `value` on a radio is in the IDL's "default" mode and reflects; on a text
 * input it is in "value" mode and does not. So :value would have been faithful
 * HERE and is the trap it has been elsewhere, which is exactly why it is not
 * worth reasoning about per element — assigning the property is faithful for
 * every one of these cases, so both go through the ref.
 *
 * That also settles `checked`: it does not reflect, so the earlier bindings in
 * #196, #217, #233 and #236 each bought an accepted markup difference that this
 * approach does not need. `disabled` in #242 reflects, so binding it was fine.
 *
 * The arrow is recreated each render, so Vue re-invokes it each render and the
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
