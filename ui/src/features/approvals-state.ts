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

/**
 * Clicks the server accepted, by question id. The action itself runs after the
 * reply and its outcome card can take a while (a deploy builds first), so the
 * card says what was decided at once instead of looking untouched until then.
 */
export const approvalDecided = ref<Record<string, 'approve' | 'reject'>>({});
