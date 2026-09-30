/**
 * Approval TTL — a pending approval that nobody answers eventually DENIES
 * itself (default 24h, NANOCLAW_APPROVAL_TTL_HOURS overrides, 0 disables).
 *
 * Why deny and not linger: a stale approval is its own hazard — the request
 * that finally gets tapped three days later executes in a context nobody
 * remembers. Expiry goes through the SAME finalizeReject path a human deny
 * uses, so the agent gets told, the cards flip everywhere, and the container
 * wakes to see the outcome.
 */
import { getExpiredPendingApprovals, getSession } from '../../db/sessions.js';
import { registerModuleSweep } from '../../module-sweep.js';
import { finalizeReject } from './finalize.js';
import { resolveSessionlessApproval } from './sessionless.js';
import { log } from '../../log.js';

const DEFAULT_TTL_HOURS = 24;

export function approvalTtlMs(): number {
  const raw = process.env.NANOCLAW_APPROVAL_TTL_HOURS;
  const hours = raw === undefined || raw === '' ? DEFAULT_TTL_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 0; // 0/invalid = disabled
  return hours * 60 * 60 * 1000;
}

/** Deny every pending approval older than the TTL. Returns how many were denied. */
export async function sweepExpiredApprovals(now = Date.now()): Promise<number> {
  const ttl = approvalTtlMs();
  if (ttl === 0) return 0;
  const reason = `no response within ${Math.round(ttl / 3_600_000)}h — expired`;
  let denied = 0;
  for (const approval of await getExpiredPendingApprovals(now - ttl)) {
    try {
      let done: boolean;
      if (!approval.session_id) {
        // Session-less (e.g. runner pairing): its owning handler takes the
        // reject, exactly as for an admin's click, and the row is removed.
        done = await resolveSessionlessApproval(approval, 'reject', 'system:expiry');
      } else {
        const session = await getSession(approval.session_id);
        if (!session) continue;
        done = await finalizeReject(approval, session, 'system:expiry', reason);
      }
      if (!done) continue;
      denied++;
      log.info('Approval expired (auto-denied)', {
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

// Unanswered approvals deny themselves after NANOCLAW_APPROVAL_TTL_HOURS
// (default 24h) — security model §approvals. Loaded via the approvals barrel.
registerModuleSweep('approval-expiry', async () => {
  await sweepExpiredApprovals();
});
