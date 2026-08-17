<script setup lang="ts">
/**
 * The model list — fourth island, and the first with a nested interactive
 * control (the − remove button) inside each row.
 *
 * Mounted into <ul id="model-list">, exclusively owned by this module.
 *
 * The remove button disables itself through the event target, exactly as the
 * imperative version did, rather than through per-row reactive state: the
 * disabled flag is transient UI feedback for one in-flight request, not
 * application state, and routing it through a ref would outlive the request.
 */
import { modelRows } from './model-list-state.js';

const emit = defineEmits<{ (e: 'pick', id: string): void; (e: 'remove', id: string, btn: HTMLButtonElement): void }>();

// Bound, not template text: prettier wraps a bare glyph onto its own line and
// Vue then renders the surrounding whitespace, which textContent never did.
const REMOVE_GLYPH = '\u2212';

const EMPTY = 'No models selected yet — use + on a server below, or “Add model endpoint…” for anything else.';

function onRemove(ev: MouseEvent, id: string) {
  ev.stopPropagation();
  emit('remove', id, ev.currentTarget as HTMLButtonElement);
}
</script>

<template>
  <li v-if="modelRows.length === 0" :style="{ cursor: 'default', opacity: 0.6 }">{{ EMPTY }}</li>
  <template v-else>
    <li
      v-for="row in modelRows"
      :key="row.id"
      :data-model-id="row.id"
      v-bind="row.active ? { class: 'active' } : {}"
      role="button"
      tabindex="0"
      @click="emit('pick', row.id)"
      @keydown.enter.prevent="emit('pick', row.id)"
      @keydown.space.prevent="emit('pick', row.id)"
    >
      <span :class="`model-kind-badge kind-${row.badgeKind}`">{{ row.badgeText }}</span>
      <span class="model-row-name">{{ row.title }}</span>
      <span v-if="row.hint" class="model-row-hint">{{ row.hint }}</span>
      <span v-else-if="row.host" class="model-row-host">{{ row.host }}</span>
      <span v-if="row.uses > 0" class="model-row-uses">{{ row.uses }}×</span>
      <button
        type="button"
        class="btn btn-ghost select-toggle on"
        title="Remove from selectable models"
        aria-label="Remove from selectable models"
        @click="onRemove($event, row.id)"
      >{{ REMOVE_GLYPH }}</button>
    </li>
  </template>
</template>
