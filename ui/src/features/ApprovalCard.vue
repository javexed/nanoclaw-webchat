<script setup lang="ts">
/**
 * One approval card — the <li> form, shared by the panel list and the
 * in-transcript card.
 *
 * NOT the toast form. renderApprovalCard() still builds that imperatively: a
 * toast is a transient element appended by the toast layer, it drops the
 * payload block, and it has no container to claim. Keeping one component for
 * two of the three callers is the honest split; forcing the third through it
 * would mean a `toast` prop that changes the element's tag.
 *
 * :class, NOT a conditional v-bind. This is the inverse of the usual case: the
 * imperative version assigned btn.className unconditionally, so an option that
 * is neither approve nor reject emits class="" — and Vue's :class emits the
 * empty attribute too. Omitting it would be the difference here.
 *
 * The busy and error state comes from module refs, not props. respondToApproval
 * used to reach into this card's DOM — disabling its buttons through
 * querySelectorAll and appending a .approval-error div to it — which is an
 * imperative writer on Vue-owned nodes. Keyed by questionId because one
 * approval can be on screen twice (the panel and the transcript).
 *
 * `disabled` reflects to an attribute, so binding it reproduces the imperative
 * assignment exactly (measured in #244) — the diff shows disabled="" on both
 * sides while a response is in flight.
 *
 * The error's v-if leaves an anchor comment when there is no error, the same
 * accepted difference as #246. It vanishes in the state that matters: with an
 * error present both sides render the div and the markup is byte-identical,
 * which is also the proof that appending it imperatively and rendering it
 * declaratively produce the same DOM.
 *
 * The default option pair is Approve/Reject. It is a fallback, not a default
 * argument — a request that supplies options replaces both, and one that
 * supplies an empty array still gets the pair.
 */
import { approvalBusy, approvalErrors } from './approvals-state.js';

const props = defineProps<{ approval: any; onRespond: (questionId: string, value: string) => void }>();

const FALLBACK = [
  { label: 'Approve', value: 'approve' },
  { label: 'Reject', value: 'reject' },
];

const options = () =>
  Array.isArray(props.approval.options) && props.approval.options.length ? props.approval.options : FALLBACK;

const payloadText = (p: any) => (typeof p === 'string' ? p : JSON.stringify(p, null, 2));
const btnClass = (v: string) => (v === 'approve' ? 'approve' : v === 'reject' ? 'reject' : '');
</script>

<template>
  <li class="approval-card" :data-question-id="approval.questionId">
    <div class="approval-title">{{ approval.title || approval.action || 'Approval requested' }}</div>
    <pre v-if="approval.payload" class="approval-payload">{{ payloadText(approval.payload) }}</pre>
    <div class="approval-actions">
      <button
        v-for="(o, i) in options()"
        :key="i"
        :class="btnClass(o.value)"
        :disabled="approvalBusy.has(approval.questionId) || undefined"
        @click="props.onRespond(approval.questionId, o.value)"
      >{{ o.label || o.value }}</button>
    </div>
    <div v-if="approvalErrors[approval.questionId]" class="approval-error">{{
      approvalErrors[approval.questionId]
    }}</div>
  </li>
</template>
