/**
 * Charge-invoker routing for /learn (learning-loop design §charge-invoker).
 *
 * The runner emits `route_learning_review` instead of running a review when a
 * shared session's `/learn` should bill the invoker. This handler makes the
 * enrollment/policy call and forwards the review as a `/learn-routed` message:
 *
 *   invoker has a connected credential → their per-member session (the
 *     container spawns under THEIR OneCLI identity — same predicate the
 *     user-credentials identity resolver uses, so routing and identity can
 *     never disagree);
 *   else, chargeInvoker 'require' → decline notice, nothing runs;
 *   else ('auto') → privileged invoker (owner/admin) falls back to the origin
 *     session on the workspace credential; everyone else gets the notice.
 *
 * The routed row carries the ORIGIN room's routing + exchange digest, so the
 * review reads the right context and its one-sentence outcome lands back in
 * the originating room. `/learn-routed` never re-emits a route action — no
 * loops.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
import { userHasConnectedCredential, type UserCredsProvider } from '../user-credentials/db.js';
import { resolveSession, writeSessionMessage, writeOutboundDirect } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The group's provider mapped to the UserCreds families (mirrors user-credentials). */
async function groupProvider(agentGroupId: string): Promise<UserCredsProvider> {
  return (await getContainerConfig(agentGroupId))?.provider === 'codex' ? 'codex' : 'claude';
}

export async function handleRouteLearningReview(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroupId = session.agent_group_id;
  const invoker = typeof content.requested_by === 'string' ? content.requested_by : null;
  const origin = (content.origin ?? {}) as { channel_type?: string | null; platform_id?: string | null };
  const text = typeof content.text === 'string' ? content.text : '/learn';
  const digest = typeof content.digest === 'string' ? content.digest : null;

  // `learning` is a JSON column; tolerate both parsed-object and raw-string
  // reads (the CRUD layer parses known JSON columns, but stay shape-robust).
  const rawLearning = (await getContainerConfig(agentGroupId))?.learning as unknown;
  let learning: { chargeInvoker?: string } | null = null;
  if (typeof rawLearning === 'string') {
    try {
      learning = JSON.parse(rawLearning) as { chargeInvoker?: string };
    } catch {
      learning = null;
    }
  } else if (rawLearning && typeof rawLearning === 'object') {
    learning = rawLearning as { chargeInvoker?: string };
  }
  // Mode: the runner's payload wins (it read the same config), else the DB,
  // else the default. 'auto' is the DEFAULT — a review is real model spend.
  const declared = typeof content.charge_mode === 'string' ? content.charge_mode : undefined;
  const raw = declared ?? learning?.chargeInvoker;
  const mode: 'off' | 'auto' | 'require' = raw === 'off' ? 'off' : raw === 'require' ? 'require' : 'auto';

  // Best-effort decline/status notice into the originating room — cosmetic
  // next to the routing decision, never throws out of the handler.
  const notice = (msg: string): void => {
    try {
      writeOutboundDirect(agentGroupId, session.id, {
        id: generateId('learn-route-notice'),
        kind: 'chat',
        platformId: origin.platform_id ?? null,
        channelType: origin.channel_type ?? null,
        threadId: null,
        content: JSON.stringify({ text: msg }),
      });
    } catch {
      /* notice only */
    }
  };

  /** Write `/learn-routed` into a session and wake it — the review runs there. */
  const forwardAsync = async (target: Session): Promise<void> => {
    const payload = JSON.stringify({
      text,
      digest,
      origin: { channel_type: origin.channel_type ?? null, platform_id: origin.platform_id ?? null },
      requested_by: invoker,
    });
    await writeSessionMessage(agentGroupId, target.id, {
      id: generateId('learn-route'),
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: origin.platform_id ?? null,
      channelType: origin.channel_type ?? null,
      threadId: null,
      content: JSON.stringify({ text: `/learn-routed ${payload}` }),
    });
    log.info('route_learning_review: forwarded', {
      agentGroupId,
      targetSession: target.id,
      selfFunded: target.id !== session.id,
      mode,
    });
    await wakeContainer(target);
  };
  // Awaited now, not fire-and-forget: pre-async the body's writes completed
  // synchronously before the void promise parked at wakeContainer, so callers
  // observed the forward as done. With every DB write async, the floated chain
  // may not even have WRITTEN the inbound row when the handler returns — the
  // caller (an MCP tool responding to the agent) would report success first.
  const forward = async (target: Session): Promise<void> => {
    await forwardAsync(target);
  };

  const enrolled = invoker !== null && (await userHasConnectedCredential(invoker, await groupProvider(agentGroupId)));
  // Access decides who may spend at all. Owner / global admin / scoped admin
  // are "privileged"; a plain member may spend only in 'off' mode (where the
  // operator has explicitly accepted shared-credential spend); a non-member
  // or unknown user never spends.
  const access = await (invoker ? canAccessAgentGroup(invoker, agentGroupId) : { allowed: false, reason: 'unknown' });
  const privileged = access.allowed && access.reason !== 'member';

  // MEMBERSHIP GATE — applies in every mode, including 'off'. An unknown
  // sender must never trigger model spend on someone else's credential.
  if (!access.allowed) {
    log.warn('route_learning_review: sender has no access to this agent group — declining', {
      agentGroupId,
      invoker,
      reason: access.reason,
    });
    notice('/learn is limited to members of this agent — nothing was run.');
    return;
  }

  // 'off' — legacy shared-credential behaviour, now membership-gated: run in
  // the origin session on the workspace credential for any member.
  if (mode === 'off') {
    await forward(session);
    return;
  }

  let target: Session;
  if (enrolled && origin.channel_type && origin.platform_id) {
    const mg = await getMessagingGroupByPlatform(origin.channel_type, origin.platform_id);
    if (!mg) {
      log.warn('route_learning_review: origin room not found — dropping', { agentGroupId, origin });
      notice('Could not route the review — the originating room was not found.');
      return;
    }
    // Member-session thread_id IS the user id — spawning it puts the review
    // under the invoker's OneCLI identity (their key pays).
    target = (await resolveSession(agentGroupId, mg.id, invoker, 'per-thread')).session;
  } else if (mode === 'require') {
    notice('/learn here runs on your own credential — connect one for this workspace, then try again.');
    return;
  } else if (!privileged) {
    notice('/learn in this room needs your own connected credential (or an admin). Nothing was run.');
    return;
  } else {
    // Privileged workspace fallback: run in the origin session on the
    // workspace credential — gated to owners/admins.
    target = session;
  }

  await forwardAsync(target);
}
