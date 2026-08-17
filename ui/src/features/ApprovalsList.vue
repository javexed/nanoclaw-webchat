<script setup lang="ts">
/**
 * The pending-approvals panel list — forty-fifth island.
 *
 * Mounted into <ul id="approval-list">, exclusively owned by this module. The
 * banner count is set outside it and stays imperative.
 */
import ApprovalCard from './ApprovalCard.vue';
import { approvalRows } from './approvals-state.js';

const props = defineProps<{ onRespond: (questionId: string, value: string) => void }>();
</script>

<template>
  <ApprovalCard
    v-for="a in approvalRows"
    :key="a.questionId"
    :approval="a"
    :on-respond="props.onRespond"
  />
</template>
