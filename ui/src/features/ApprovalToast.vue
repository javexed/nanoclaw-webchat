<script setup lang="ts">
/**
 * The transient approval toast, deliberately not ApprovalCard: a <div> without the payload
 * block, placed by the toast layer. Mounted into the toast element itself, which carries
 * the class and data-question-id that respondToApproval selects on. Busy state is shared
 * with the card via approvalBusy, so clicking either disables both.
 */
import { approvalBusy } from './approvals-state.js';

const props = defineProps<{ approval: any; onRespond: (questionId: string, value: string) => void }>();

const FALLBACK = [
  { label: 'Approve', value: 'approve' },
  { label: 'Reject', value: 'reject' },
];

// A reason needs room to type: the toast offers the quick answers, the card the rest.
const options = () =>
  (Array.isArray(props.approval.options) && props.approval.options.length ? props.approval.options : FALLBACK).filter(
    (o: { value: string }) => o.value !== 'reject_with_reason',
  );

const btnClass = (v: string) => (v === 'approve' ? 'approve' : v === 'reject' ? 'reject' : '');
</script>

<template>
  <div class="approval-title">{{ approval.title || approval.action || 'Approval requested' }}</div>
  <div class="approval-actions">
    <button
      v-for="(o, i) in options()"
      :key="i"
      :class="btnClass(o.value)"
      :disabled="approvalBusy.has(approval.questionId) || undefined"
      @click="props.onRespond(approval.questionId, o.value)"
    >{{ o.label || o.value }}</button>
  </div>
</template>
