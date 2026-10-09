<script setup lang="ts">
/**
 * A button's label with its busy state: spinner and verb while `busy`
 * (core/busy.ts buttonBusy, for templates). Disable the button alongside.
 */
defineProps<{ busy: boolean; label: string; busyLabel: string }>();
</script>

<template>
  <template v-if="busy"><span class="btn-spinner" aria-hidden="true"></span>{{ busyLabel }}</template>
  <template v-else>{{ label }}</template>
</template>
