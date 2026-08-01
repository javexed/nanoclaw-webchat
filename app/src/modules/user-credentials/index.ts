/**
 * UserCreds module — secure shared-room bring-your-own-key.
 *
 * Self-registers a session-key resolver so that, in a webchat room opted into
 * a non-disabled credential mode, a member who has connected their own
 * Anthropic key gets their OWN per-member session (keyed by userId). That
 * session's container spawns under the member's OneCLI identity, so the
 * gateway injects their key — no shared per-turn token, nothing to replay.
 *
 * Imported for side effects by src/modules/index.js (added by the installer).
 */
import {
  registerSessionKeyResolver,
  registerSessionInboundWriter,
  registerTurnGate,
  resolveSession,
  writeOutboundDirect,
} from '../../session-manager.js';
import {
  registerAgentIdentityResolver,
  registerContainerEnvResolver,
  registerSessionPrepareHook,
} from '../../container-runtime.js';
import { writeMemberTranscript } from './fanout.js';
import { log } from '../../log.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { registerApprovalAgentGroupFallback } from '../approvals/onecli-approvals.js';
import { getEffectiveRoomMode, getCredentialsConfig } from '../../channels/webchat/db.js';
import {
  userHasConnectedCredential,
  getUserCredential,
  agentGroupForUserCredsAgent,
  type UserCredsProvider,
} from './db.js';
import { ensureGroupEnrollment } from './onboard.js';
import { realOnecliAdmin } from './onecli-admin.js';
import {
  memberSessionKey,
  memberUserFromKey,
  userCredsAgentIdentifier,
  WORKSPACE_DEFAULT_USER_ID,
} from './identity.js';

/** The agent group's provider, mapped to the two UserCreds-supported families. */
function groupProvider(agentGroupId: string): UserCredsProvider {
  return getContainerConfig(agentGroupId)?.provider === 'codex' ? 'codex' : 'claude';
}

// Sentinel bearer for a per-member OAuth container. Its value is irrelevant
// beyond being non-empty: it flips Claude Code into OAuth mode (so it sends
// `Authorization: Bearer <sentinel>` + the oauth beta header), and OneCLI
// overwrites it on the wire with the member's real vault token. Mirrors the
// host-side drafter (src/channels/webchat/drafter.ts).
const OAUTH_SENTINEL = 'placeholder';

/**
 * One evaluation feeding BOTH routing seams: the session-key resolver (route a
 * permitted member to their per-member session) and the turn gate (veto a
 * 'required' room for a member with no permitted credential).
 */
function evaluateRoomCredState(
  mg: { id: string; channel_type: string; platform_id: string },
  agentGroupId: string,
  userId: string | null,
  threadId?: string | null,
): { override: { sessionMode: 'per-thread'; threadId: string } | null; requiredBlocked: boolean; credName: string } {
  const none = { override: null, requiredBlocked: false, credName: '' };
  // UserCreds is webchat-only and opt-in per room. Fail safe to no effect.
  if (mg.channel_type !== 'webchat' || !userId) return none;
  if (!hasTable(getDb(), 'webchat_room_settings')) return none;
  // Effective mode = the room's override, else the global default. Which
  // credential TYPES the workspace accepts (key / OAuth, per provider) is set on
  // the Credentials admin page; the room's mode is the master switch over both.
  const provider = groupProvider(agentGroupId);
  const cfg = getCredentialsConfig();
  const mode = getEffectiveRoomMode(mg.platform_id);
  // 'disabled' (User credentials: Off) means no UserCreds at all — neither key nor
  // OAuth — regardless of what the workspace accepts. Otherwise each method
  // applies if the workspace accepts it for this provider.
  const apiOffered = mode !== 'disabled' && (provider === 'codex' ? cfg.allowOpenaiKey : cfg.allowAnthropicKey);
  const oauthOffered = mode !== 'disabled' && (provider === 'codex' ? cfg.allowCodexOauth : cfg.allowClaudeOauth);
  if (!apiOffered && !oauthOffered) return none; // UserCreds entirely off here.

  // A member gets their own per-member session ONLY if their connected credential
  // is still PERMITTED by current policy — so flipping an allowance off (or a
  // room to disabled) stops already-connected members routing, not just new ones.
  // The per-(user,group) OneCLI agent is created lazily at spawn (prepare hook).
  const cred = getUserCredential(userId, provider);
  if (cred?.status === 'active') {
    const permitted = cred.cred_type === 'oauth_token' ? oauthOffered : apiOffered;
    // Key by (user, thread), not user alone: a per-member session that ignores
    // the thread collapses a room's threads into one queue, and the agent then
    // answers a room message into a topic thread.
    if (permitted)
      return { ...none, override: { sessionMode: 'per-thread', threadId: memberSessionKey(userId, threadId) } };
  }
  // No permitted credential: API-key 'required' rooms decline with guidance;
  // otherwise (optional, or OAuth-only) fall back to the shared session.
  const credName = provider === 'codex' ? 'Codex credential' : 'Anthropic key';
  return { ...none, requiredBlocked: mode === 'required', credName };
}

registerSessionKeyResolver((mg, agentGroupId, userId, threadId) => {
  return evaluateRoomCredState(mg, agentGroupId, userId, threadId).override;
});

// The veto half (seam contract: core records the drop with our reason; the
// user-facing notice is OURS to post). De-duped per (room, user) for a short
// window so context fan-out in multi-agent rooms doesn't repeat the notice.
const noticeSentAt = new Map<string, number>();
const NOTICE_DEDUPE_MS = 5 * 60 * 1000;
registerTurnGate((mg, agentGroupId, userId) => {
  // FAIL CLOSED where it matters (the seam skips a throwing gate): if we
  // cannot evaluate credential state, a required-mode room must veto rather
  // than silently bill the workspace key. Known-optional/disabled rooms keep
  // availability on an evaluation bug.
  let state: ReturnType<typeof evaluateRoomCredState>;
  try {
    state = evaluateRoomCredState(mg, agentGroupId, userId);
  } catch (err) {
    let required = true; // unknown mode → treat as required
    try {
      required = getEffectiveRoomMode(mg.platform_id) === 'required';
    } catch {
      /* mode unreadable too — stay closed */
    }
    if (!required) return null;
    log.warn('UserCreds gate: evaluation failed in a required-mode room — vetoing (fail closed)', {
      agentGroupId,
      roomId: mg.platform_id,
      err: String(err),
    });
    return { reason: 'user-creds-evaluation-failed' };
  }
  if (!state.requiredBlocked) return null;
  const dedupeKey = `${mg.id}:${userId}`;
  const last = noticeSentAt.get(dedupeKey) ?? 0;
  if (Date.now() - last > NOTICE_DEDUPE_MS) {
    noticeSentAt.set(dedupeKey, Date.now());
    // Best-effort: a failed notice must never cancel the veto (the whole
    // point is that the shared key is not billed).
    try {
      // Write into the room's REAL shared session (idempotently resolved) so
      // the sweep delivery poll actually delivers it — the previous target
      // (session id == agentGroupId) exists in no sessions row, so the notice
      // was written where nothing ever read it.
      const noticeSession = resolveSession(agentGroupId, mg.id, null, 'shared').session;
      writeOutboundDirect(agentGroupId, noticeSession.id, {
        id: `user-creds-block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: mg.platform_id,
        channelType: mg.channel_type,
        threadId: null,
        content: JSON.stringify({
          text: `This room requires your own ${state.credName} — connect it in the banner above the chat.`,
        }),
      });
    } catch {
      /* notice is cosmetic next to the veto */
    }
  }
  return { reason: 'user-creds-required-no-key' };
});

// A per-member session (thread_id = userId) whose member has connected a
// credential for this room's provider spawns under the member's own OneCLI
// identity → gateway injects THEIR credential. The agent itself is created by
// the prepare hook below (which runs first), so this just names it.
registerAgentIdentityResolver((agentGroupId, threadId) => {
  // A per-member session key is (user, thread); older ones are a bare user id.
  // Decode, falling back to the raw value so both shapes resolve to the same
  // credential identity — an undecoded key would find no credential and drop
  // the container to the workspace default WITHOUT failing, i.e. running on
  // the wrong identity.
  const userId = memberUserFromKey(threadId) ?? threadId;
  if (userId && userHasConnectedCredential(userId, groupProvider(agentGroupId))) {
    return userCredsAgentIdentifier(agentGroupId, userId);
  }
  return null;
});

// Lazy / just-in-time enrollment: the first time a connected member's session is
// spawned in a room, create their per-(user,group) OneCLI agent and assign their
// secret + the group's tool secrets. Runs before identity resolution. Idempotent
// + a fast no-op once enrolled, so it costs nothing on subsequent spawns.
registerSessionPrepareHook(async (agentGroupId, threadId) => {
  const userId = memberUserFromKey(threadId) ?? threadId;
  if (!userId || !userHasConnectedCredential(userId, groupProvider(agentGroupId))) return;
  await ensureGroupEnrollment(realOnecliAdmin, userId, agentGroupId);
});

// Claude OAuth members: put their per-member container in subscription/OAuth mode
// with a SENTINEL token and route Anthropic THROUGH OneCLI — OneCLI swaps the
// sentinel for the member's real token (a `generic` vault secret injected as
// `Authorization: Bearer …`). The real token never enters the container.
//
// Crucially we also BLANK `ANTHROPIC_API_KEY`: the OneCLI gateway sets it to
// `placeholder` on every agent so api-key agents send `x-api-key` for the
// gateway to overwrite. But an OAuth member's secret rewrites `Authorization`,
// not `x-api-key`, so a lingering `x-api-key: placeholder` would reach Anthropic
// and be rejected ("invalid API key"). Blanking it makes Claude Code use pure
// OAuth mode — `Authorization: Bearer` + the oauth beta header, no x-api-key.
// extraEnv is applied AFTER the gateway env, so this override wins.
//
// API-key members get {} (their key rides x-api-key, which the gateway swaps).
// Codex members get {}: gated on the Claude provider; Codex auth rides OneCLI's
// gateway auth.json stub (keyed by the per-member identity) — no env var.
//
// BASE sessions (no credentialed member — threadId null, a topic-thread id, or a
// member whose credential was revoked) run under the group's base OneCLI agent,
// which auto-injects the WORKSPACE DEFAULT secret in `all` mode. If that default
// is a subscription (OAuth) token, the base container needs the exact same
// sentinel treatment — otherwise it stays in x-api-key mode, the OAuth secret
// rewrites `Authorization` but not `x-api-key`, and Anthropic rejects the
// lingering `x-api-key: placeholder`. An API-key default needs nothing.
registerContainerEnvResolver((agentGroupId, threadId): Record<string, string> => {
  if (groupProvider(agentGroupId) !== 'claude') return {};
  const oauthEnv = { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_SENTINEL, ANTHROPIC_API_KEY: '' };
  // Per-member session: the member's own credential decides the container mode.
  const memberUserId = memberUserFromKey(threadId) ?? threadId;
  if (memberUserId) {
    const cred = getUserCredential(memberUserId, 'claude');
    if (cred?.status === 'active') return cred.cred_type === 'oauth_token' ? oauthEnv : {};
  }
  // Base session: the workspace default serves it.
  const ws = getUserCredential(WORKSPACE_DEFAULT_USER_ID, 'claude');
  if (ws?.status === 'active' && ws.cred_type === 'oauth_token') return oauthEnv;
  return {};
});

// Approval routing: reverse a UserCreds per-member identity back to its agent group
// so credentialed-action approvals from a member's container reach the group's
// approvers.
registerApprovalAgentGroupFallback((externalId) => agentGroupForUserCredsAgent(externalId));

// Shared context: on a per-member wake, write the full room transcript into the
// member's session (current → trigger=1, rest → trigger=0).
registerSessionInboundWriter(writeMemberTranscript);

export {};
