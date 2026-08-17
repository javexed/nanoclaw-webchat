<script setup lang="ts">
/**
 * The room ↔ agent wiring matrix — thirty-ninth island.
 *
 * Mounted into <div id="matrix-canvas">, exclusively owned by this module.
 *
 * The cells carry data-room and data-agent and are NOT wired here. A delegated
 * click handler on the canvas reads those attributes and toggles the edge —
 * one listener for a grid that can be rooms × agents cells, which is why it was
 * delegated in the first place. Putting @click on every cell would multiply the
 * listener count by the grid size, and the listener-set guard would be right to
 * flag it.
 *
 * The empty state replaces the whole table, as before: a matrix with no rooms
 * or no agents has nothing to render, not an empty grid.
 */
import { computed } from 'vue';
import { matrixAgents, matrixEdges, matrixRooms } from './matrix-state.js';

const EMPTY = 'Nothing to wire yet — create a room and an agent first.';
const CORNER = 'Room \\ Agent';
const NO_MODEL = 'no model';

const empty = computed(() => matrixRooms.value.length === 0 || matrixAgents.value.length === 0);
const isOn = (roomId: string, agentId: string) => matrixEdges.value.has(`${roomId}|${agentId}`);
</script>

<template>
  <template v-if="empty">{{ EMPTY }}</template>
  <table v-else class="matrix-table">
    <thead>
      <tr>
        <th class="matrix-corner">{{ CORNER }}</th>
        <th v-for="a in matrixAgents" :key="a.id" class="matrix-agent-head">
          <div class="matrix-agent-name">{{ a.name }}</div>
          <div :class="a.modelName ? 'matrix-model-chip' : 'matrix-model-chip none'">{{ a.modelName || NO_MODEL }}</div>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="room in matrixRooms" :key="room.id">
        <th class="matrix-room-head">{{ room.name }}</th>
        <td
          v-for="a in matrixAgents"
          :key="a.id"
          :class="isOn(room.id, a.id) ? 'matrix-cell on' : 'matrix-cell'"
          :data-room="room.id"
          :data-agent="a.id"
          :title="`${room.name} ↔ ${a.name}`"
        ></td>
      </tr>
    </tbody>
  </table>
</template>
