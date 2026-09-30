<script setup lang="ts">
/**
 * One approval card — the <li> form shared by the panel list and the in-transcript
 * card (the toast form is built by renderApprovalCard). Busy and error state come from
 * module refs keyed by questionId, because one approval can be on screen twice. A
 * request with no options, or an empty array, falls back to Approve/Reject.
 */
import { approvalBusy, approvalErrors } from './approvals-state.js';

/**
 * Triage — why this request is in front of a human. Chips are checkable CLAIMS, never
 * a risk level or confidence score: the triage model cannot withhold a review, so it
 * must not be trusted to reassure either. Never-list chips are authoritative
 * (deterministic) and render beside model chips so a disagreement stays visible. The
 * note makes ABSENCE legible: "no chips" must never read as "screened, nothing found".
 */
const TIER_NOTE: Record<string, string> = {
  unscreened: 'Not screened',
  heuristic: 'Always requires a human',
  unavailable: 'Screening unavailable',
};

const triage = () => props.approval.triage as
  | { tier: string; reason: string; flags: string[]; heuristic: string[]; reversible: string }
  | undefined;

/** Never-list flags first — they are the ones that need no trust. */
const triageChips = (): Array<{ flag: string; authoritative: boolean }> => {
  const t = triage();
  if (!t) return [];
  const heuristic = Array.isArray(t.heuristic) ? t.heuristic : [];
  const model = Array.isArray(t.flags) ? t.flags : [];
  return [
    ...heuristic.map((flag) => ({ flag, authoritative: true })),
    ...model.filter((f) => !heuristic.includes(f)).map((flag) => ({ flag, authoritative: false })),
  ];
};

/** The model's one-line reason when it has one, else why no reason exists. */
const triageNote = (): string => {
  const t = triage();
  if (!t) return TIER_NOTE.unscreened;
  if (t.tier === 'model') return t.reason || '';
  return TIER_NOTE[t.tier] || '';
};

const chipTitle = (authoritative: boolean) =>
  authoritative ? 'Always requires a human' : 'Proposed by the triage model — check it against the payload';

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
    <div v-if="triageChips().length || triageNote()" class="approval-triage">
      <span
        v-for="c in triageChips()"
        :key="c.flag"
        class="triage-flag"
        :class="{ authoritative: c.authoritative }"
        :title="chipTitle(c.authoritative)"
      >{{ c.flag }}</span>
      <span v-if="triageNote()" class="triage-note">{{ triageNote() }}</span>
    </div>
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
