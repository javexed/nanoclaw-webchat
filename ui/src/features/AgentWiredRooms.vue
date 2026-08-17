<script setup lang="ts">
/**
 * The rooms an agent is wired to — fourteenth island.
 *
 * Mounted into <ul id="agent-wired-rooms">, exclusively owned by this module.
 *
 * #agent-rooms-count and #agent-add-room-toggle are NOT part of this island.
 * They live outside the mount point and agents.ts still sets them imperatively,
 * which is the rule the islands have followed throughout: a component owns the
 * subtree it is mounted on and nothing else.
 *
 * The remove button's icon goes through v-html because lucide() returns SVG
 * markup, exactly as `removeBtn.innerHTML = lucide('x')` did. It is a constant
 * from our own icon set, not user data.
 */
import { computed } from 'vue';
import { lucide } from '../core/dom.js';
import { canManageRooms, wiredRooms } from './agent-detail-state.js';

const props = defineProps<{
  onOpenRoom: (roomId: string) => void;
  onRemoveRoom: (roomId: string, roomName: string) => void;
}>();

const EMPTY = 'Not assigned to any room yet.';
const XICON = lucide('x');

const rows = computed(() =>
  wiredRooms.value.map((room: any) => {
    // The room's only agent cannot be unassigned — the room would be left with
    // none, so the backend refuses and the button says why instead.
    const onlyAgent = room.agent_count <= 1;
    return {
      id: room.id,
      name: room.name ?? '',
      isPrime: !!room.is_prime,
      openTitle: `Open ${room.name} settings`,
      onlyAgent,
      removeTitle: onlyAgent
        ? "Cannot unassign — this agent is the room's only agent (delete the room instead)"
        : `Remove this agent from ${room.name}`,
    };
  }),
);

function onKey(e: KeyboardEvent, id: string) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    props.onOpenRoom(id);
  }
}
</script>

<template>
  <li v-if="rows.length === 0" class="empty-note">{{ EMPTY }}</li>
  <li v-for="r in rows" :key="r.id">
    <span
      class="room-wired-name room-wired-name-link"
      role="button"
      tabindex="0"
      :title="r.openTitle"
      @click="props.onOpenRoom(r.id)"
      @keydown="onKey($event, r.id)"
      >{{ r.name }}<span v-if="r.isPrime" class="room-wired-prime-badge"> default</span></span
    >
    <button
      v-if="canManageRooms"
      type="button"
      class="room-wired-remove"
      :title="r.removeTitle"
      :disabled="r.onlyAgent"
      v-html="XICON"
      @click="props.onRemoveRoom(r.id, r.name)"
    ></button>
  </li>
</template>
