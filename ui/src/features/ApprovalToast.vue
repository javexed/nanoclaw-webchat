<script setup lang="ts">
/**
 * The transient approval toast.
 *
 * Deliberately NOT ApprovalCard: a toast is a <div class="approval-toast">, it
 * drops the payload block, and the toast layer owns where it goes. The two
 * shared a builder before and the difference was a `toast` flag that changed
 * the element's tag — one component for both would need the same flag back.
 *
 * Mounted into the toast element itself, one app per toast, so the host carries
 * the class and data-question-id the toast layer and respondToApproval select
 * on, and the component supplies its children.
 *
 * Busy state is shared with the card via approvalBusy, keyed by questionId —
 * the same approval can be on screen as a toast AND in the panel, and clicking
 * either should disable both.
 */
import { approvalBusy } from './approvals-state.js';

const props = defineProps<{ approval: any; onRespond: (questionId: string, value: string) => void }>();

const FALLBACK = [
  { label: 'Approve', value: 'approve' },
  { label: 'Reject', value: 'reject' },
];

const options = () =>
  Array.isArray(props.approval.options) && props.approval.options.length ? props.approval.options : FALLBACK;

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
