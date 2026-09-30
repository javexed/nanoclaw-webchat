<script setup lang="ts">
/**
 * The room ↔ agent wiring matrix, mounted into <div id="matrix-canvas">. Cells carry
 * data-room/data-agent and have no listeners: one delegated handler on the canvas toggles
 * edges for the whole grid. With no rooms or no agents, the empty state replaces the table.
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
