/**
 * Session-less approvals — the minimal sibling of `requestApproval()` for
 * actions that have no agent session behind them (today: runner pairing).
 *
 * It reuses everything that makes approvals ONE system: `pickApprover` (owners
 * + global admins, the same fan-out set), `pickAllApprovalDeliveries`, the
 * `pending_approvals` row (with `session_id` NULL — the column is nullable for
 * exactly this) and the same `ask_question` card, so the response dispatcher
 * sees an ordinary click. What it leaves out is everything that presumes a
 * session: agent notification, wake, reason capture, intercepts.
 */
import { normalizeOptions } from '../../channels/ask-question.js';
import { createPendingApproval, deletePendingApproval, transitionPendingApprovalStatus } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { PendingApproval } from '../../types.js';
import { APPROVAL_OPTIONS, pickAllApprovalDeliveries, pickApprover } from './primitive.js';

export interface SessionlessApprovalRequest {
  /** Must match the key registered via registerSessionlessApprovalHandler. */
  action: string;
  payload: Record<string, unknown>;
  title: string;
  question: string;
}

export interface SessionlessApprovalContext {
  approval: PendingApproval;
  payload: Record<string, unknown>;
  outcome: 'approve' | 'reject';
  /** The admin who clicked. */
  userId: string;
}
export type SessionlessApprovalHandler = (ctx: SessionlessApprovalContext) => Promise<void>;

const handlers = new Map<string, SessionlessApprovalHandler>();

export function registerSessionlessApprovalHandler(action: string, handler: SessionlessApprovalHandler): void {
  if (handlers.has(action)) throw new Error(`Session-less approval handler already registered: ${action}`);
  handlers.set(action, handler);
}
export function __resetSessionlessApprovalsForTest(): void {
  handlers.clear();
}

/** Raise the card to every owner/global admin. Returns the approval id, or null when nobody could be reached. */
export async function requestSessionlessApproval(req: SessionlessApprovalRequest): Promise<string | null> {
  const { action, payload, title, question } = req;
  const approvers = await pickApprover(null);
  if (approvers.length === 0) {
    log.warn('Session-less approval: no owner or global admin to ask', { action });
    return null;
  }
  const targets = await pickAllApprovalDeliveries(approvers);
  if (targets.length === 0) {
    log.warn('Session-less approval: no DM channel for any approver', { action, approvers });
    return null;
  }
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Session-less approval: no delivery adapter', { action });
    return null;
  }
  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await createPendingApproval({
    approval_id: approvalId,
    session_id: null,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    instance: targets[0]?.messagingGroup.instance ?? null,
    title,
    question,
    options_json: JSON.stringify(normalizeOptions(APPROVAL_OPTIONS)),
    approver_user_id: null,
  });
  const cardJson = JSON.stringify({
    type: 'ask_question',
    questionId: approvalId,
    title,
    question,
    options: APPROVAL_OPTIONS,
  });
  let delivered = 0;
  for (const target of targets) {
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        cardJson,
        undefined,
        target.messagingGroup.instance,
      );
      delivered++;
    } catch (err) {
      log.error('Session-less approval: card delivery failed', { action, approvalId, approver: target.userId, err });
    }
  }
  if (delivered === 0) {
    await deletePendingApproval(approvalId);
    return null;
  }
  log.info('Session-less approval requested', { action, approvalId, approvers: targets.map((t) => t.userId) });
  return approvalId;
}

/**
 * Called by the response dispatcher for a row with no session. Returns false
 * when no handler owns the action (the dispatcher then drops the row as it
 * always did). Any non-approve option is a reject; "reject with reason" has
 * no agent to carry the reason to, so it is a plain reject here.
 */
export async function resolveSessionlessApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<boolean> {
  const handler = handlers.get(approval.action);
  if (!handler) return false;
  const outcome: 'approve' | 'reject' = selectedOption === 'approve' ? 'approve' : 'reject';
  // Same double-click guard as the session path: the first click flips the
  // status; a second one finds nothing to transition and is ignored.
  if (outcome === 'approve' && !(await transitionPendingApprovalStatus(approval.approval_id, 'pending', 'approved')))
    return true;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(approval.payload) as Record<string, unknown>;
  } catch {
    /* an unparsable payload still resolves — the handler sees {} */
  }
  try {
    await handler({ approval, payload, outcome, userId });
  } finally {
    await deletePendingApproval(approval.approval_id);
  }
  return true;
}
