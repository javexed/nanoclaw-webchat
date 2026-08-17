<script setup lang="ts">
/**
 * The approval pre-judge's judge-model options — sixty-third island.
 *
 * Mounted into <select id="prejudge-model-select">, exclusively owned by this
 * module. Everything else renderPrejudgeSettings does — hiding the section,
 * fetching the config, assigning the select's value and its onchange — is state
 * applied to static markup and stays imperative.
 *
 * "Off" is rendered HERE rather than left in index.html. It is in the static
 * markup, but the imperative version cleared the select and rebuilt Off as the
 * first option every time; Vue replaces the host's children on mount, so the
 * static one would be wiped and never come back. Reproducing it is what keeps
 * the two agreeing.
 *
 * Only models the PUT accepts are listed — anthropic kind (OneCLI-proxied), or
 * a local kind with an endpoint. That filter stays in the renderer: it is a
 * fact about the API contract, not about this markup.
 *
 * The select's own `value` is assigned by the renderer AFTER awaiting nextTick.
 * Options now appear a tick later than the assignment that selects one, which
 * they did not when both were synchronous — assigning first would silently
 * select nothing and read back as "the stored judge left the roster".
 */
import { prejudgeModelOptions } from './prejudge-state.js';

const OFF = 'Off';
</script>

<template>
  <option value="">{{ OFF }}</option>
  <option v-for="m in prejudgeModelOptions" :key="m.id" :value="m.id">{{ m.label }}</option>
</template>
