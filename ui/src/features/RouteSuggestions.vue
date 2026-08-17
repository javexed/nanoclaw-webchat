<script setup lang="ts">
/**
 * Capability routes the router could add but hasn't — sixty-first island.
 *
 * Mounted into <div id="route-suggestions">, exclusively owned by this module.
 * The host's own `hidden` flag stays imperative: Vue manages an element's
 * CHILDREN, not the element, and hiding an empty box is the renderer's job in
 * exactly the way #agent-keys-count was.
 *
 * The sentence was built with innerHTML and esc() — two <strong> spans inside
 * running text. It is written here on ONE line: the imperative version produced
 * no whitespace around the tags, and template text carries its newlines.
 *
 * Creating a route disables its button while the save is in flight and
 * re-enables it if the save fails. That is an async pass reaching back into an
 * already-rendered row, so it is state (`routeSuggestBusy`) rather than a DOM
 * mutation — the same reason skillUpdating exists.
 *
 * The busy state produces NO markup difference, unlike the `checked` cases in
 * #196, #217, #233 and #236. `disabled` is a reflected IDL attribute: the
 * imperative `btn.disabled = true` writes `disabled=""` into the DOM just as
 * :disabled does. `checked` does not reflect — that is why those slices had a
 * difference to accept and this one does not. The busy-state diff is run
 * anyway, and confirms it.
 */
import { routeSuggestBusy, routeSuggestions } from './route-list-state.js';

const props = defineProps<{ onCreate: (s: any) => void }>();
</script>

<template>
  <div v-for="s in routeSuggestions" :key="s.capability" class="route-suggestion">
    <span class="route-suggestion-text"><strong>{{ s.model }}</strong> can do <strong>{{ s.capability }}</strong> — no route covers it yet.</span>
    <button
      class="btn btn-secondary"
      type="button"
      :disabled="routeSuggestBusy.has(s.capability) || undefined"
      @click="props.onCreate(s)"
    >Create {{ s.capability }} route</button>
  </div>
</template>
