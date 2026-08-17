<script setup lang="ts">
/**
 * The "learn with which agent?" body — sixty-sixth island.
 *
 * Per-instance and provide()-injected, like the two confirm bodies in #246 and
 * for the same reasons. showConfirmModal's element-body contract is unchanged.
 *
 * The room select is DERIVED from the agent select rather than rebuilt by a
 * change handler. That was the imperative syncRooms(): clear the options,
 * append the new ones, and hide the whole select when the agent serves one room.
 * As a computed it is the same rule stated once.
 *
 * Both selects are UNCONTROLLED — the caller reads .value at confirm time, so
 * no v-model. The agent select does carry one @change, which is exactly the one
 * listener the imperative version bound; it only updates which rooms are
 * derived, and never writes the select's own value back.
 *
 * The initial agent is assigned once in onMounted, not through a binding. The
 * original set agentSel.value AFTER appending the options — a select's value
 * cannot be set before the option exists — and a per-render assignment would
 * fight the user's own selection.
 *
 * Attribute order follows the imperative assignment order, which the DOM diff
 * enforces: class before aria-label on the selects, and value/disabled/title on
 * the options (new Option(text, value) sets value first).
 *
 * Hence :value.attr on the agent options. Vue sets an <option>'s value as a DOM
 * PROPERTY, which reflects to the attribute afterwards and therefore lands it
 * LAST — the diff read `disabled title value` against the original's
 * `value disabled title`. The .attr modifier makes it a plain attribute so it
 * is written in template order. The room options never carry a second
 * attribute, so the order cannot show there.
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
