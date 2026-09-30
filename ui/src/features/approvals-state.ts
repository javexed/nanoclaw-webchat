// ── Approvals state ─────────────────────────────────────────────────────────
// Bridge ref for the ApprovalsList island. approvals.ts owns
// pendingApprovals and the fetch; this mirrors it for rendering.
import { ref } from 'vue';

/** Pending approvals, as the panel list renders them. */
export const approvalRows = ref<any[]>([]);

/**
 * Question ids whose respond call is in flight, and the inline error left by
 * one that failed. State rather than DOM writes: ApprovalCard owns the card's nodes.
 */
export const approvalBusy = ref<Set<string>>(new Set());
export const approvalErrors = ref<Record<string, string>>({});
