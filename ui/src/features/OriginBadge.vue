<script setup lang="ts">
/**
 * The provenance pill for a skill or MCP server; the declarative half of origin-badge.ts.
 * Every decision — including the http(s) test that keeps a javascript:/data: URL out of
 * an href — comes from originBadgeProps(), so the security check has exactly one copy.
 * Clicks stop propagating because the rows carrying a badge are themselves clickable.
 */
import { computed } from 'vue';
import { originBadgeProps, type Origin } from './origin-badge.js';

const props = defineProps<{ origin: Origin }>();

const p = computed(() => originBadgeProps(props.origin));

/** One object, so absent values emit no attribute (a :style would emit style=""). */
const attrs = computed(() => {
  const v = p.value;
  const out: Record<string, unknown> = { class: v.className };
  if (v.hue !== null) out.style = { '--badge-hue': v.hue };
  if (v.href) {
    out.href = v.href;
    out.target = '_blank';
    out.rel = 'noopener noreferrer';
    out.title = v.title;
    // Attached here, on the anchor only, not as a template @click on every plain span.
    out.onClick = (e: Event) => e.stopPropagation();
  }
  return out;
});
</script>

<template>
  <component :is="p.tag" v-bind="attrs">{{ p.label }}</component>
</template>
