<script setup lang="ts">
/**
 * The @-mention autocomplete popover, mounted into the element ensureMentionPopover()
 * creates. mousedown and touchstart, NOT click: the composer's blur dismisses the popover
 * before click fires, and on iOS synthesized mouse events can land after the dismiss
 * timer. preventDefault keeps the input focused. Placement is pure CSS.
 */
import { mentionMatches, mentionSelectedIndex } from './mention-popover-state.js';

const props = defineProps<{ onPick: (index: number) => void }>();

const PERSON = 'person';
const DEFAULT_AGENT = 'default';
/** Bound, with its LEADING SPACE; as template text the space would become a newline plus indentation. */
const nameLabel = (a: any) => ` — ${a.name}`;

function pick(e: Event, i: number) {
  e.preventDefault();
  props.onPick(i);
}
</script>

<template>
  <div
    v-for="(agent, i) in mentionMatches"
    :key="agent.folder ?? i"
    :class="i === mentionSelectedIndex ? 'mention-popover-item active' : 'mention-popover-item'"
    @mousedown="pick($event, i)"
    @touchstart.prevent="pick($event, i)"
  >
    <span class="mention-popover-slug">@{{ agent.folder }}</span
    ><span v-if="agent.name && agent.name !== agent.folder" class="mention-popover-name">{{ nameLabel(agent) }}</span
    ><span v-if="agent.isUser" class="mention-popover-person">{{ PERSON }}</span
    ><span v-else-if="agent.is_prime" class="mention-popover-prime">{{ DEFAULT_AGENT }}</span>
  </div>
</template>
