<script setup lang="ts">
/**
 * The @-mention autocomplete popover — thirty-seventh island.
 *
 * Mounted into the popover element ensureMentionPopover() creates, which is
 * appended next to the composer once and reused.
 *
 * mousedown and touchstart, NOT click. The composer's blur dismisses the
 * popover, and blur fires before click — so a click handler would never run.
 * touchstart is there for iOS, where the synthesized mouse events can land
 * after the blur-dismiss timer. preventDefault keeps the input focused.
 *
 * Placement is pure CSS (absolute above the composer) — nothing to compute.
 */
import { mentionMatches, mentionSelectedIndex } from './mention-popover-state.js';

const props = defineProps<{ onPick: (index: number) => void }>();

const PERSON = 'person';
const DEFAULT_AGENT = 'default';
/**
 * Bound, with its LEADING SPACE. The imperative version set textContent to
 * ' — ' + name; as template text the space becomes a newline plus indentation.
 */
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
