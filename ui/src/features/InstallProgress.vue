<script setup lang="ts">
/**
 * The progress box for a long-running install (DESIGN.md, "Long-running
 * operations"): installLogText's progress line, then the log tail. Place it
 * below the control that started it, never under a sticky action bar.
 */
defineProps<{ text: string }>();
</script>

<template>
  <pre v-if="text" class="wizard-code" aria-live="polite">{{ text }}</pre>
</template>
