<script setup lang="ts">
/**
 * The router's model roster, mounted into <ul id="router-roster-list">. One empty state
 * covers both "router not answering" and "answered with no models".
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
