<script setup lang="ts">
/**
 * The "learn with which agent?" body for showConfirmModal; per-instance and
 * provide()-injected like ConfirmInput. The room select is derived from the agent
 * select. Both selects are uncontrolled (the caller reads .value at confirm time), and
 * the initial agent is assigned once in onMounted, after its option exists. :value.attr
 * on the agent options keeps value ahead of disabled/title in attribute order.
 */
import { computed, inject, onMounted, ref } from 'vue';

const s = inject<any>('learnTarget');
const agent = ref(s.initialAgent);

const rooms = computed(() => s.roomsByAgent.get(agent.value) || []);

function captureAgent(el: any): void {
  if (el) s.agentEl = el;
}
function captureRoom(el: any): void {
  if (el) s.roomEl = el;
}

onMounted(() => {
  if (s.agentEl) s.agentEl.value = s.initialAgent;
});

function onAgentChange(e: any): void {
  agent.value = e.target.value;
}
</script>

<template>
  <select class="confirm-input" aria-label="Agent" :ref="captureAgent" @change="onAgentChange">
    <option
      v-for="a in s.agents"
      :key="a.id"
      :value.attr="a.id"
      :disabled="(s.roomsByAgent.get(a.id) || []).length === 0 || undefined"
      :title="(s.roomsByAgent.get(a.id) || []).length === 0 ? 'No room' : undefined"
    >{{ a.name }}</option>
  </select>
  <select class="confirm-input" aria-label="Room" :ref="captureRoom" :hidden="rooms.length <= 1">
    <option v-for="r in rooms" :key="r.id" :value="r.id">{{ r.name }}</option>
  </select>
</template>
