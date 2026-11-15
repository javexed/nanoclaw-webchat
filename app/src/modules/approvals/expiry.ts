/**
 * Approval TTL — a pending approval that nobody answers eventually stops
 * waiting (default 24h, NANOCLAW_APPROVAL_TTL_HOURS overrides, 0 disables).
 *
 * Why not linger: a stale approval is its own hazard — the request that
 * finally gets tapped three days later executes in a context nobody
 * remembers. An expiry is NOT a rejection, so it is not worded as one: the
 * row turns `expired` (kept a while so a person can send the identical
 * request again, see resend.ts), the agent is told plainly that nobody
 * answered, the cards flip everywhere through the resolved callbacks, and the
 * container wakes to see the outcome.
 */
import { getDb } from '../../db/connection.js';
import {
  deletePendingApproval,
  getExpiredPendingApprovals,
  getSession,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import { registerModuleSweep } from '../../module-sweep.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { finalizeReject } from './finalize.js';
import { notifyApprovalResolved } from './primitive.js';
import { resolveSessionlessApproval } from './sessionless.js';
import { log } from '../../log.js';

const DEFAULT_TTL_HOURS = 24;
/** The credential gateway's approval action (gateway-approval-coordinator.ts). */
const GATEWAY_ACTION = 'gateway_request';
/** How long an expired request can still be sent again. */
export const RESEND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Who an expiry is attributed to on the resolved callbacks. */
export const EXPIRY_USER = 'system:expiry';

export function approvalTtlMs(): number {
  const raw = process.env.NANOCLAW_APPROVAL_TTL_HOURS;
  const hours = raw === undefined || raw === '' ? DEFAULT_TTL_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 0; // 0/invalid = disabled
  return hours * 60 * 60 * 1000;
}

/** "24 hours", "90 minutes". */
export function ttlWords(ttl = approvalTtlMs()): string {
  const hours = ttl / 3_600_000;
  if (hours >= 1 && Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(ttl / 60_000)} minutes`;
}

/** What the request was, in the agent's terms: `ncl workloads-up`, or the action name. */
export function requestLabel(approval: Pick<PendingApproval, 'action' | 'payload'>): string {
  if (approval.action === 'cli_command') {
    try {
      const cmd = (JSON.parse(approval.payload) as { frame?: { command?: unknown } }).frame?.command;
      if (typeof cmd === 'string' && cmd) return `\`ncl ${cmd}\``;
    } catch {
      /* fall through */
    }
  }
  return approval.action.replace(/_/g, ' ');
}

/**
 * A surface where a person can send an expired request again (webchat rooms
 * do, from the expired notice). It decides the agent's advice: wait for the
 * person, or ask again itself.
 */
type ResendSurface = (session: Session) => Promise<boolean>;
let resendSurface: ResendSurface | null = null;
export function registerResendSurface(fn: ResendSurface | null): void {
  resendSurface = fn;
}

/** The agent's note on an expiry. */
export async function expiryWords(approval: PendingApproval, session: Session): Promise<string> {
  const what = requestLabel(approval);
  const head = `Your approval request for ${what} expired: nobody answered within ${ttlWords()}, so it did not run. Nobody rejected it.`;
  let resendable = false;
  try {
    resendable = resendSurface ? await resendSurface(session) : false;
  } catch {
    resendable = false;
  }
  return resendable
    ? `${head} The conversation shows a "Send again" button that re-issues the same request; don't ask again yourself unless someone tells you to.`
    : `${head} If it's still wanted, make the request again.`;
}

/** Expire one session approval: status, agent note, resolved callbacks, wake. */
async function expireApproval(approval: PendingApproval, session: Session): Promise<boolean> {
  if (!(await transitionPendingApprovalStatus(approval.approval_id, 'pending', 'expired'))) return false;
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: await expiryWords(approval, session), sender: 'system', senderId: 'system' }),
  });
  await notifyApprovalResolved({ approval, session, outcome: 'reject', userId: EXPIRY_USER });
  await requestWake(session, 'approval-response');
  return true;
}

/** Expire every pending approval older than the TTL. Returns how many expired. */
export async function sweepExpiredApprovals(now = Date.now()): Promise<number> {
  const ttl = approvalTtlMs();
  if (ttl === 0) return 0;
  let denied = 0;
  for (const approval of await getExpiredPendingApprovals(now - ttl)) {
    try {
      let done: boolean;
      if (!approval.session_id) {
        // Session-less (e.g. a workload card): its owning handler takes the
        // reject, exactly as for an admin's click, and the row is removed.
        done = await resolveSessionlessApproval(approval, 'reject', EXPIRY_USER);
      } else {
        const session = await getSession(approval.session_id);
        if (!session) continue;
        // The credential gateway's holds keep the reject they always had: the
        // gateway coordinator owns their lifecycle and does its own expiry.
        done =
          approval.action === GATEWAY_ACTION
            ? await finalizeReject(approval, session, EXPIRY_USER, {
                reason: `no response within ${ttlWords()} — expired`,
              })
            : await expireApproval(approval, session);
      }
      if (!done) continue;
      denied++;
      log.info('Approval expired', {
        approvalId: approval.approval_id,
        action: approval.action,
        ageHours: Math.round((now - Date.parse(approval.created_at)) / 3_600_000),
      });
    } catch (err) {
      log.warn('Approval expiry sweep: finalize failed', { approvalId: approval.approval_id, err: String(err) });
    }
  }
  return denied;
}

/** Drop expired rows once they can no longer be sent again. Returns how many. */
export async function sweepStaleExpiredApprovals(now = Date.now()): Promise<number> {
  const rows = await getDb().all<PendingApproval>(`SELECT * FROM pending_approvals WHERE status = 'expired'`);
  let dropped = 0;
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    if (Number.isFinite(t) && t + approvalTtlMs() + RESEND_WINDOW_MS > now) continue;
    await deletePendingApproval(r.approval_id);
    dropped++;
  }
  return dropped;
}

// Unanswered approvals expire after NANOCLAW_APPROVAL_TTL_HOURS
// (default 24h) — security model §approvals. Loaded via the approvals barrel.
registerModuleSweep('approval-expiry', async () => {
  await sweepExpiredApprovals();
  await sweepStaleExpiredApprovals();
});
