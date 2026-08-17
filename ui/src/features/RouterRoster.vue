<script setup lang="ts">
/**
 * The router's model roster — twenty-fourth island.
 *
 * Mounted into <ul id="router-roster-list">, exclusively owned by this module.
 *
 * Unblocked by the select-toggle extraction: this list could not become an
 * island while its +/- control arrived as a DOM node from legacy.
 *
 * The empty state covers two different situations the original also merged —
 * the router not answering at all, and answering with an empty model list. The
 * wording ("not reachable right now") is kept as-is; splitting them would be a
 * copy change, not a conversion.
 */
import SelectToggle from './SelectToggle.vue';
import { rosterEndpoint, rosterSelectable, rosterSystem, rosterUnreachable } from './router-roster-state.js';

const UNREACHABLE = 'Router not reachable right now…';
const SYS_HEADING = 'System — not selectable';
const CLASSIFIER = 'classifier';
const CLASSIFIER_TITLE =
  'Auto-routing classifier — infrastructure, not a selectable or route-target model';
</script>

<template>
  <li v-if="rosterUnreachable" class="ollama-muted">{{ UNREACHABLE }}</li>
  <template v-else>
    <li v-for="id in rosterSelectable" :key="id">
      <span class="ollama-model-name">{{ id }}</span
      ><SelectToggle kind="openai-compatible" :endpoint="rosterEndpoint" :model-id="id" :display-name="id" />
    </li>
    <template v-if="rosterSystem.length">
      <li class="ollama-model-sysheading">{{ SYS_HEADING }}</li>
      <li v-for="id in rosterSystem" :key="id">
        <span class="ollama-model-name">{{ id }}</span
        ><span class="ollama-model-systag" :title="CLASSIFIER_TITLE">{{ CLASSIFIER }}</span>
      </li>
    </template>
  </template>
</template>
