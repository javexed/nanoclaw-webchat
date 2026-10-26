<script setup lang="ts">
/**
 * One value in the attachment drawer's JSON tree. Objects and arrays are native
 * <details> so expand/collapse is keyboard- and screen-reader-operable with no
 * script; the first two levels start open. Values render as text (never HTML).
 */
import { ref } from 'vue';

defineOptions({ name: 'JsonNode' });

const props = defineProps<{ name?: string | number; value: unknown; depth: number }>();

// Children render only while open, and at most CHILD_LIMIT of them: a closed
// branch of a 100k-element array costs one row, not 100k hidden ones.
const CHILD_LIMIT = 500;
const open = ref(props.depth < 2);

const isBranch = (v: unknown) => v !== null && typeof v === 'object';
const allEntries = (v: unknown): [string | number, unknown][] =>
  Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v as Record<string, unknown>);
const entries = (v: unknown) => allEntries(v).slice(0, CHILD_LIMIT);
const hidden = (v: unknown) => Math.max(0, allEntries(v).length - CHILD_LIMIT);
const summary = (v: unknown) => (Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v as object).length}}`);
const leafClass = (v: unknown) =>
  typeof v === 'string' ? 'hl-s' : typeof v === 'number' ? 'hl-n' : v === null || typeof v === 'boolean' ? 'hl-k' : '';
const leafText = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
const label = () => (props.name === undefined ? '' : typeof props.name === 'number' ? `${props.name}` : props.name);
</script>

<template>
  <details
    v-if="isBranch(value)"
    class="json-node"
    :open="open"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary>
      <span v-if="name !== undefined" class="json-key">{{ label() }}</span>
      <span class="json-count">{{ summary(value) }}</span>
    </summary>
    <div v-if="open" class="json-children">
      <JsonNode v-for="[k, v] in entries(value)" :key="k" :name="k" :value="v" :depth="depth + 1" />
      <div v-if="hidden(value)" class="json-more">… {{ hidden(value) }} more</div>
    </div>
  </details>
  <div v-else class="json-leaf">
    <span v-if="name !== undefined" class="json-key">{{ label() }}</span>
    <span :class="leafClass(value)">{{ leafText(value) }}</span>
  </div>
</template>
