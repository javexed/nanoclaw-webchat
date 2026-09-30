<script setup lang="ts">
/**
 * The approval pre-judge's judge-model options, mounted into
 * <select id="prejudge-model-select">. "Off" renders here because mounting replaces the
 * host's static children. Only models the PUT accepts are listed (filtered in the
 * renderer), which assigns the select's value after nextTick, once the options exist.
 */
import { prejudgeModelOptions } from './prejudge-state.js';

const OFF = 'Off';
</script>

<template>
  <option value="">{{ OFF }}</option>
  <option v-for="m in prejudgeModelOptions" :key="m.id" :value="m.id">{{ m.label }}</option>
</template>
