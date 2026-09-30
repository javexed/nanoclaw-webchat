<script setup lang="ts">
/**
 * The +/− selectable-model control; the component half of select-toggle.ts, which decides
 * what it shows and what the click does (the click DELETES an existing registration), so
 * this and buildSelectToggle() cannot drift. `busy` is local: rows are mid-request
 * independently.
 */
import { computed, ref } from 'vue';
import { selectToggleProps, toggleSelectable } from './select-toggle.js';

const props = defineProps<{ kind: string; endpoint: string; modelId: string; displayName: string }>();

const busy = ref(false);
const p = computed(() => selectToggleProps(props.kind, props.endpoint, props.modelId));

function onClick() {
  void toggleSelectable(props.kind, props.endpoint, props.modelId, props.displayName, (b) => {
    busy.value = b;
  });
}
</script>

<template>
  <button
    type="button"
    :class="p.className"
    :title="p.title"
    :aria-label="p.title"
    :disabled="busy || undefined"
    @click="onClick"
  >{{ p.label }}</button>
</template>
