// ── Approvals state ─────────────────────────────────────────────────────────
// Bridge ref for the ApprovalsList island. approvals.ts still owns
// pendingApprovals and the fetch; this mirrors it for rendering.
import { ref } from 'vue';

/** Pending approvals, as the panel list renders them. */
export const approvalRows = ref<any[]>([]);

/**
 * Question ids whose respond call is in flight, and the inline error left by
 * one that failed.
 *
 * These were DOM writes: respondToApproval took the card element, disabled its
 * buttons through querySelectorAll and appended a .approval-error div to it.
 * The panel's cards are rendered by ApprovalCard, so those writes were landing
 * on Vue-owned nodes — the two-writers shape, reached from the imperative side.
 */
export const approvalBusy = ref<Set<string>>(new Set());
export const approvalErrors = ref<Record<string, string>>({});
