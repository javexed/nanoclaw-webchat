<script setup lang="ts">
/**
 * Capability routes the router could add, mounted into <div id="route-suggestions">; the
 * host's hidden flag stays with the renderer. The sentence stays on ONE template line so
 * no whitespace appears around its <strong> tags. A create in flight disables its button
 * through `routeSuggestBusy` state rather than a DOM write.
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
