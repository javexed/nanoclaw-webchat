<script setup lang="ts">
/**
 * The pending-approvals panel list, mounted into <ul id="approval-list">.
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
