<script setup lang="ts">
/**
 * The provenance pill — where a skill or MCP server comes from.
 *
 * Not an island: it has no mount point of its own. It is the declarative half
 * of origin-badge.ts, used by islands that render rows containing a badge,
 * while the still-imperative call sites keep using originBadgeEl().
 *
 * Every decision — element type, classes, hue, and the http(s) test that keeps
 * a javascript:/data: URL out of an href — comes from originBadgeProps(). This
 * component makes none of them. That is the whole point of the split: writing
 * the conditionals again here would put a second copy of a security check in
 * the codebase, and the copy that drifts is the one that stops checking.
 *
 * The click handler stops propagation because the rows that carry a badge are
 * themselves clickable (they open an editor), matching the imperative version.
 */
import { computed } from 'vue';
import { originBadgeProps, type Origin } from './origin-badge.js';

const props = defineProps<{ origin: Origin }>();

const p = computed(() => originBadgeProps(props.origin));

/**
 * Built as one object so absent values emit NO attribute rather than an empty
 * one. :href="null" removes it, but --badge-hue via :style would still emit
 * style="", which is the class of difference the first island was caught on.
 */
const attrs = computed(() => {
  const v = p.value;
  const out: Record<string, unknown> = { class: v.className };
  if (v.hue !== null) out.style = { '--badge-hue': v.hue };
  if (v.href) {
    out.href = v.href;
    out.target = '_blank';
    out.rel = 'noopener noreferrer';
    out.title = v.title;
    // The listener goes in HERE, not as a template @click. The imperative
    // version attaches it only on the anchor; a template handler would attach
    // one to every plain span too, which the listener-set guard counts as a
    // gained listener — and it would be right to.
    out.onClick = (e: Event) => e.stopPropagation();
  }
  return out;
});
</script>

<template>
  <component :is="p.tag" v-bind="attrs">{{ p.label }}</component>
</template>
