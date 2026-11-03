/**
 * "Send again" for an approval that expired with nobody answering: re-issue
 * the IDENTICAL request through the path it first took, so nothing is
 * trusted from the old card.
 *
 *   - `ncl` commands replay through dispatch() as the agent that asked: the
 *     guard runs again, the command's precheck runs again (and pins fresh
 *     values, so the new card shows what would run now), and the same
 *     approver rules pick who gets the card. A command that no longer needs
 *     approval simply runs, like it would for the agent.
 *   - Other module approvals go back through requestApproval with the same
 *     action, payload and card text.
 *
 * The expired row is claimed (deleted) first, so two clicks re-issue once.
 */
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext, RequestFrame } from '../../cli/frame.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getPendingApproval, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestLabel } from './expiry.js';
import { notifyAgent, requestApproval } from './primitive.js';
import { describeApprovedOutcome, outcomeText, personName, redactResultText } from './words.js';

export type ResendResult = { ok: true; note: string } | { ok: false; reason: string };

function agentContext(value: unknown): CallerContext | null {
  const r = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  if (
    r.caller === 'agent' &&
    typeof r.sessionId === 'string' &&
    typeof r.agentGroupId === 'string' &&
    typeof r.messagingGroupId === 'string'
  ) {
    return {
      caller: 'agent',
      sessionId: r.sessionId,
      agentGroupId: r.agentGroupId,
      messagingGroupId: r.messagingGroupId,
    };
  }
  return null;
}

/** Claim an expired row: true for exactly one caller. */
async function claimExpired(approvalId: string): Promise<boolean> {
  const r = await getDb().run(`DELETE FROM pending_approvals WHERE approval_id = ? AND status = 'expired'`, approvalId);
  return (r.changes ?? 0) > 0;
}

/** Re-issue an expired approval request on behalf of `byUserId`. */
export async function resendExpiredApproval(approvalId: string, byUserId: string): Promise<ResendResult> {
  const row = await getPendingApproval(approvalId);
  if (!row || row.status !== 'expired') {
    return { ok: false, reason: 'This request was already sent again, or is too old to send again.' };
  }
  const session = row.session_id ? await getSession(row.session_id) : undefined;
  if (!session) return { ok: false, reason: 'The conversation that asked for it is gone.' };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'The request could not be read.' };
  }
  if (!(await claimExpired(approvalId))) {
    return { ok: false, reason: 'This request was already sent again.' };
  }

  const who = await personName(byUserId);
  const what = requestLabel(row);

  if (row.action === 'cli_command') {
    const frame = payload.frame as RequestFrame | undefined;
    const ctx = agentContext(payload.callerContext);
    if (!frame || typeof frame.command !== 'string' || !ctx) {
      return { ok: false, reason: 'The request could not be read.' };
    }
    const response = await dispatch({ ...frame, id: `resend-${Date.now()}` }, ctx);
    if (!response.ok && response.error.code === 'approval-pending') {
      await notifyAgent(session, `${who} sent your expired request for ${what} again. ${response.error.message}`);
      log.info('Expired approval sent again', { approvalId, action: row.action, by: byUserId });
      return { ok: true, note: 'Sent again.' };
    }
    if (response.ok) {
      // It no longer needs a card (e.g. now within what was approved): it ran.
      const o = describeApprovedOutcome(frame, response);
      await notifyAgent(
        session,
        `${who} sent your expired request for ${what} again; it no longer needed approval and ran. ${outcomeText(o).replace(/^Approved and done\. /, '')}`,
      );
      return { ok: true, note: 'It no longer needed approval, so it ran.' };
    }
    const reason = redactResultText(response.error.message);
    await notifyAgent(
      session,
      `${who} tried to send your expired request for ${what} again, but it was refused: ${reason}`,
    );
    return { ok: false, reason: `It can't be sent again as it was: ${reason}` };
  }

  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? session.agent_group_id;
  await requestApproval({
    session,
    agentName,
    action: row.action,
    payload,
    title: row.title || row.action,
    question: row.question,
  });
  await notifyAgent(
    session,
    `${who} sent your expired request for ${what} again. A new approval card is up; you will be told the result.`,
  );
  log.info('Expired approval sent again', { approvalId, action: row.action, by: byUserId });
  return { ok: true, note: 'Sent again.' };
}
