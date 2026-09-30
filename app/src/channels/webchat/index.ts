/**
 * Webchat channel — embedded HTTP + WebSocket chat server with PWA frontend.
 *
 * Disabled by default (`WEBCHAT_ENABLED=true` in .env); binds `WEBCHAT_HOST`
 * (default 127.0.0.1) : `WEBCHAT_PORT` (default 3100). Auth methods and their
 * resolution order live in auth.ts. The adapter mirrors agent traffic into
 * webchat_messages for the PWA's history; routing/delivery still flows through
 * the session DBs like every other channel.
 */
// Side-effect import — must run before any transitive webchat import that
// reads `process.env.WEBCHAT_*` at module load (auth.ts, server.ts, push.ts,
// drafter.ts). See env-load.ts for the rationale.
import './env-load.js';
// Side-effect import — an installed tree whose data dir is gone refuses to
// boot before main() would create a fresh, empty database (data-guard.ts).
import './data-guard.js';

import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getPendingApproval } from '../../db/sessions.js';
import { registerLearningClassifierResolver } from '../../container-runtime-extras.js';
import { registerContainerConfigAugmentor, registerSessionPrepareHook } from '../../seam/index.js';
import { registerA2aRouteObserver } from '../../seam/index.js';
import { classifierParamsForModel } from './models.js';
import { registerChannelAdapter } from '../channel-registry.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from '../adapter.js';
import type { AgentActivityStatus } from '../../seam/index.js';
import { runChannelStart } from './extensions.js';
import { isOllamaLenient, primeOllamaLenient, refreshOllamaLenient } from './ollama-lenient.js';
// Registers every installed extension before the server starts.
import './extensions-installed.js';
import { pruneSigninSessions } from './signins.js';
import { pruneAuditFiles } from '../../audit.js';
import { redactSensitiveData } from './redact.js';
import { startWebchatServer, stopWebchatServer, type WebchatServer } from './server.js';
import { sweepMcpHealth } from './mcp-health.js';
import { startMcpRelayIfAssigned, stopMcpRelay } from './mcp-relay.js';
import {
  APPROVAL_INBOX_PREFIX,
  deleteWebchatApprovalIndex,
  findActiveAgentForWebchatRoom,
  getEffectiveModelForAgent,
  getWebchatApprovalInboxes,
  getWebchatRoom,
  isApprovalInbox,
  markRoomApprovalResolved,
  markRoomSkillDraftResolved,
  skillDraftCardPosition,
  recordWebchatApproval,
  storeWebchatApprovalCard,
  storeWebchatSkillDraftCard,
  sessionKeyToThread,
  userForApprovalInbox,
  type WebchatRoomAgent,
  recordActivity,
  pruneActivity,
} from './db.js';
import {
  broadcast,
  pushApprovalResolvedToUser,
  pushApprovalToUser,
  recordTurnStart,
  recordTurnEnd,
  surfaceA2aMessage,
} from './state.js';
import { registerApprovalResolvedHandler } from '../../modules/approvals/primitive.js';
import { registerApprovalIntercept, registerApprovalRequestedListener } from '../../seam/index.js';
import { buildApprovalTriageView, maybePrejudgeApproval } from '../../modules/approvals/prejudge.js';
import { startReconcileLoop, stopReconcileLoop } from './reconcile.js';
import { deliveryKey, storeAgentDelivery } from './agent-delivery.js';
import {
  registerSkillDraftProposedListener,
  registerSkillDraftResolvedListener,
} from '../../modules/learning/events.js';
import { listSkillDrafts, resolveSkillDraft } from '../../db/skill-drafts.js';

export const CHANNEL_TYPE = 'webchat';

function isEnabled(): boolean {
  return process.env.WEBCHAT_ENABLED === 'true';
}

function createAdapter(): ChannelAdapter {
  let server: WebchatServer | null = null;
  // Captured at setup() time so deliver()'s loop-back fan-out can re-enter
  // the router. Null before setup, immutable after.
  let adapterConfig: ChannelSetup | null = null;

  const adapter: ChannelAdapter = {
    name: 'webchat',
    channelType: CHANNEL_TYPE,
    // A session per (room, thread); main keys the null-thread session. See
    // docs/webchat/threads.md and threadToSessionKey().
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      adapterConfig = config;
      server = await startWebchatServer({
        onInbound: (roomId, message, threadId) => {
          void (async () => {
            // Surface the room's display name to the router so messaging_groups
            // gets a friendly label on first sight (mirrors discord/slack).
            const room = await getWebchatRoom(roomId);
            if (room) {
              config.onMetadata(roomId, room.name, true);
            }
            // Standard inbound — userId resolution + access gating happens in
            // the router/permissions module via the `senderId` field that the
            // server attaches to message.content. threadId is the session key.
            await config.onInbound(roomId, threadId, message);
          })().catch((err) => log.error('Webchat inbound failed', { roomId, err }));
        },
        onAction: (questionId, selectedOption, userId) => {
          config.onAction(questionId, selectedOption, userId);
        },
      });
      log.info('Webchat channel listening', { host: server.host, port: server.port, tls: server.tls });
      // Recovers messages marked delivered but never delivered (see reconcile.ts).
      startReconcileLoop(server);
      // Prune the durable activity log past its 30-day window. Daily is ample —
      // it is a retention floor, not a size cap, and the volume is modest.
      activityPruneTimer = setInterval(
        () => {
          pruneActivity().catch((err) => log.error('Activity-log prune failed', { err }));
          pruneSigninSessions().catch((err) => log.error('Sign-in session prune failed', { err }));
          // The audit log also prunes when it rolls over, but a quiet install may not
          // write for days: age its day files out here too.
          pruneAuditFiles();
        },
        24 * 60 * 60 * 1000,
      );
      // Hourly draft-expiry sweep (see sweepExpiredSkillDrafts above).
      draftExpiryTimer = setInterval(
        () => {
          try {
            sweepExpiredSkillDrafts().catch((err) => log.error('Draft expiry sweep failed', { err }));
          } catch (err) {
            log.error('Draft expiry sweep failed', { err });
          }
        },
        60 * 60 * 1000,
      );
      // MCP auth relay (credentials stay host-side) + hourly health/drift sweep.
      // Binds only if a server assignment already carries a relay token; an
      // install with no authed remote MCP server never opens the port.
      void startMcpRelayIfAssigned();
      // Before any spawn reads it: which groups run on a local Ollama model.
      primeOllamaLenient().catch((err) => log.warn('Ollama lenient-mode prime failed', { err }));
      // Installed extensions' own background services (./extensions.ts).
      runChannelStart();
      mcpHealthTimer = setInterval(
        () => {
          sweepMcpHealth().catch((err) => log.error('MCP health sweep failed', { err }));
        },
        60 * 60 * 1000,
      );
      // First pass shortly after boot so the MCP tab has fresh status.
      setTimeout(() => {
        sweepMcpHealth().catch((err) => log.error('MCP health sweep failed', { err }));
      }, 30_000).unref?.();
      // Agents spawned outside the PWA (e.g. a2a `create_agent`) are not wired
      // to a room; the operator wires them on demand.
    },

    async teardown(): Promise<void> {
      stopReconcileLoop();
      stopMcpRelay();
      if (mcpHealthTimer) {
        clearInterval(mcpHealthTimer);
        mcpHealthTimer = null;
      }
      if (draftExpiryTimer) {
        if (activityPruneTimer) clearInterval(activityPruneTimer);
        clearInterval(draftExpiryTimer);
        draftExpiryTimer = null;
      }
      if (server) {
        await stopWebchatServer(server);
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async openDM(handle: string): Promise<string> {
      // Per-user approval inbox: synthetic messaging_groups row keyed on the
      // handle, hidden from the room list. requestApproval() ultimately calls
      // adapter.deliver(channel_type='webchat', platform_id=this) which we
      // route to a per-user WS push instead of storing as a chat message.
      const platformId = `${APPROVAL_INBOX_PREFIX}${handle}`;
      if (!(await getMessagingGroupByPlatform('webchat', platformId))) {
        await createMessagingGroup({
          id: randomUUID(),
          channel_type: 'webchat',
          platform_id: platformId,
          name: `Approvals (${handle})`,
          is_group: 0,
          unknown_sender_policy: 'public',
          created_at: new Date().toISOString(),
        });
      }
      return platformId;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      if (!server) return undefined;

      // Approval inbox path: ask_question payloads (and only those) to a
      // synthetic approvals: platform_id push to the connected approver's
      // clients via WS. They never become chat messages.
      if (isApprovalInbox(platformId)) {
        const handle = platformId.slice(APPROVAL_INBOX_PREFIX.length);
        const approverUserId = `webchat:${handle}`;
        const content = message.content as Record<string, unknown> | string | undefined;
        if (content && typeof content === 'object' && content.type === 'ask_question') {
          // Index it for /api/approvals/pending (trunk leaves
          // pending_approvals.platform_id unset). questionId IS the approval_id.
          const approvalId = (content as { questionId?: unknown }).questionId;
          if (typeof approvalId === 'string' && approvalId.length > 0) {
            await recordWebchatApproval(approvalId, platformId);
          } else {
            log.warn('Webchat: ask_question card missing questionId — approval not indexed', {
              platformId,
            });
          }
          pushApprovalToUser(approverUserId, content);
        } else {
          log.warn('Webchat: non-ask_question delivery to approval inbox dropped', {
            platformId,
            kind: typeof content === 'object' ? (content as { type?: string }).type : typeof content,
          });
        }
        return undefined;
      }

      const roomId = platformId;
      const room = await getWebchatRoom(roomId);
      if (!room) {
        log.warn('Webchat deliver: unknown room', { roomId });
        return undefined;
      }
      // The producing agent: delivery.ts's senderAgentGroupId is ground truth
      // (it polled that session's outbound.db); the heuristic is a fallback.
      let producer = await (message.senderAgentGroupId ? lookupAgentForMessage(message.senderAgentGroupId) : null);
      if (!producer) producer = await findActiveAgentForWebchatRoom(roomId);
      const senderName = producer?.name ?? agentDisplayName();
      const text = extractText(message);
      // The reply belongs to the producing session's thread. The session key
      // (null = main) maps back to the stored/UI thread id.
      // roomId lets this reject a per-member session key masquerading as a
      // thread id (see sessionKeyToThread) instead of minting a phantom thread.
      const storeThread = await sessionKeyToThread(threadId, roomId);
      const storedMessageId = await storeAgentDelivery(server, {
        key: deliveryKey(message.senderSessionId, roomId, storeThread, message.content),
        roomId,
        senderName,
        text,
        files: message.files,
        thread: storeThread,
      });
      // Loop-back fan-out: re-enter the router so other wired agents in this
      // room can react to the producer's text (matches the "agents talk in
      // the room" mental model). Guarded by:
      //   • self-exclusion in router (the producer never re-engages itself)
      //   • prime-skip in router  (catch-all wirings don't fire on agent posts)
      //   • per-room rate limit   (circuit breaker against pathological chains)
      // Skipped when producer can't be resolved or there's no text payload
      // (files alone don't trigger — no @-mention to match against).
      if (adapterConfig && producer && text !== null && text.length > 0 && shouldLoopBack(roomId)) {
        const senderAgentGroupId = producer.id;
        const loopbackId =
          storedMessageId ?? `webchat-loopback-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        // Attribution via `author.fullName`/`userName`, which the senderResolver
        // ignores for identity: a plain `sender` would create a
        // `webchat:<AgentName>` pseudo-user row on every loop-back.
        void Promise.resolve(
          adapterConfig.onInbound(roomId, threadId, {
            id: loopbackId,
            kind: 'chat',
            content: {
              text,
              author: { fullName: senderName, userName: senderName },
              senderAgentGroupId,
            },
            timestamp: new Date().toISOString(),
            isMention: false,
            isGroup: true,
            senderAgentGroupId,
          }),
        ).catch((err) => log.error('Webchat loop-back inbound failed', { roomId, err }));
      }
      return undefined;
    },

    async setTyping(platformId, _threadId, agentName): Promise<void> {
      if (!server) return;
      server.broadcast(platformId, {
        type: 'typing',
        room_id: platformId,
        // Prefer the actual typing agent's name (multi-agent rooms); fall back to
        // the room's default agent for older callers that don't pass it.
        identity: agentName || (await senderForRoom(platformId)),
        identity_type: 'agent',
        is_typing: true,
      });
    },
    async sendStatus(platformId, _threadId, status: AgentActivityStatus): Promise<void> {
      if (!server) return;
      // Redact before broadcast — tool targets (file paths, commands) and
      // reasoning summaries can echo secrets. The whole room sees this frame.
      const redact = (s: string | null): string | null => (s == null ? null : redactSensitiveData(s));
      // Track turn lifecycle so a client that re-joins mid-turn can replay the
      // bubble (a leave→return otherwise loses it — status frames are ephemeral
      // and room-scoped). Fall back to a stable key when the frame is unnamed.
      const turnAgent = status.agentName ?? '';
      if (status.kind === 'start') recordTurnStart(platformId, turnAgent);
      else if (status.kind === 'done' || status.kind === 'stalled') recordTurnEnd(platformId, turnAgent);
      const text = redact(status.text);
      const detail = redact(status.detail);
      server.broadcast(platformId, {
        type: 'status',
        room_id: platformId,
        agent_name: status.agentName ?? null,
        event: status.kind,
        text,
        detail,
      });
      // Durable copy of the same (already-redacted) frame — the live broadcast
      // is ephemeral and room-scoped; this is what survives the turn for the
      // 30-day store and click-to-expand. Fire-and-forget: never delay the feed.
      void recordActivity({
        roomId: platformId,
        agentName: status.agentName ?? null,
        kind: status.kind,
        text,
        detail,
        createdAt: Date.now(),
      });
    },
  };

  return adapter;
}

// Per-room circuit breaker for loop-back chains that escape self-exclusion and
// prime-skip (two agents @-mentioning each other): 30 events / 60s per room
// lets multi-hop conversations through and clips infinite ping-pong.
const LOOPBACK_WINDOW_MS = 60_000;
const LOOPBACK_MAX_PER_WINDOW = 30;
const loopbackHistory = new Map<string, number[]>();

function shouldLoopBack(roomId: string): boolean {
  const now = Date.now();
  const cutoff = now - LOOPBACK_WINDOW_MS;
  const recent = (loopbackHistory.get(roomId) ?? []).filter((t) => t >= cutoff);
  if (recent.length >= LOOPBACK_MAX_PER_WINDOW) {
    log.warn('Webchat: loop-back rate limit hit, dropping agent fan-out', {
      roomId,
      windowMs: LOOPBACK_WINDOW_MS,
      cap: LOOPBACK_MAX_PER_WINDOW,
    });
    loopbackHistory.set(roomId, recent);
    return false;
  }
  recent.push(now);
  loopbackHistory.set(roomId, recent);
  return true;
}

/** Exact lookup of the producing agent by id; null if it vanished before delivery. */
async function lookupAgentForMessage(agentGroupId: string): Promise<WebchatRoomAgent | null> {
  const ag = await getAgentGroup(agentGroupId);
  return ag ? { id: ag.id, name: ag.name, folder: ag.folder } : null;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function agentDisplayName(): string {
  return process.env.AGENT_DISPLAY_NAME || 'Agent';
}

/**
 * The agent display name for a room (findActiveAgentForWebchatRoom), else
 * AGENT_DISPLAY_NAME or 'Agent'.
 */
async function senderForRoom(roomId: string): Promise<string> {
  const agent = await findActiveAgentForWebchatRoom(roomId);
  return agent?.name || agentDisplayName();
}

registerChannelAdapter('webchat', {
  factory: () => (isEnabled() ? createAdapter() : null),
});

// Lenient output + prompt for Ollama-backed groups (see ./ollama-lenient.ts).
// The prepare hook is a safety net; the cache is primed at boot and refreshed
// on every model write, because the augmentor runs before prepare hooks.
registerSessionPrepareHook((agentGroupId) => refreshOllamaLenient(agentGroupId));
registerContainerConfigAugmentor((agentGroupId) =>
  isOllamaLenient(agentGroupId) ? { lenientOutput: true, lenientPrompt: true } : {},
);

// Auto-default the learning classifier to the agent's OWN model when it runs on
// a local endpoint (ollama/openai-compatible) — zero setup. Claude agents have
// no local endpoint, so this returns null and the runner keeps the busy-turn
// heuristic. An explicit Settings override still wins (see container-config.ts).
registerLearningClassifierResolver(async (agentGroupId) =>
  classifierParamsForModel(await getEffectiveModelForAgent(agentGroupId)),
);

// Side-channel a2a visibility: a read-only copy of each routed message in every
// room both agents share. The observer wrapper isolates failures from routing.
registerA2aRouteObserver(({ fromAgentGroupId, toAgentGroupId, content }) => {
  surfaceA2aMessage(fromAgentGroupId, toAgentGroupId, content).catch((err) =>
    log.warn('a2a surface failed', { err: String(err) }),
  );
});

// Optional LLM approval pre-judge (off by default): may auto-approve an opted-in
// low-stakes action via the human Approve path. Returning true skips the card.
registerApprovalIntercept((approvalId, session, question) => maybePrejudgeApproval(approvalId, session, question));

// Fan-out cleanup: on resolve, push `approval_resolved` to every inbox that got
// the card (the live clear; offline admins refetch), then drop the index rows.
registerApprovalResolvedHandler(async (event) => {
  const approvalId = event.approval.approval_id;
  const resolvedByUserId = event.userId;
  const indexed = await getWebchatApprovalInboxes(approvalId);
  for (const platformId of indexed) {
    const userId = userForApprovalInbox(platformId);
    if (userId) {
      // An approver inbox — clear the card from that admin's inbox.
      pushApprovalResolvedToUser(userId, approvalId, resolvedByUserId);
    } else {
      // The agent's room — flip the in-room card to resolved + clear live.
      await markRoomApprovalResolved(approvalId, resolvedByUserId);
      await broadcast(platformId, { type: 'approval_resolved', approvalId, resolvedBy: resolvedByUserId });
    }
  }
  if (indexed.length > 0) await deleteWebchatApprovalIndex(approvalId);
});

/** Seam listeners are called synchronously: run an async one and log its failure. */
const asyncListener =
  <E>(name: string, fn: (e: E) => Promise<void>) =>
  (e: E): void => {
    fn(e).catch((err) => log.error(`${name} listener failed`, { err }));
  };

// Surface an ACTIONABLE approval card into the requesting agent's own room (in
// addition to the per-approver inboxes), so admins can act without hunting in
// the Approvals inbox. The room is also indexed so the resolved-listener above
// clears the card on first response. Best-effort; webchat rooms only.
registerApprovalRequestedListener(
  asyncListener('approvalRequested', async (e) => {
    const mg = await (e.session.messaging_group_id ? getMessagingGroup(e.session.messaging_group_id) : null);
    if (!mg || mg.channel_type !== 'webchat') return;
    const roomId = mg.platform_id;
    // The pre-judge's reasoning for the card. No stored row renders as
    // `unscreened`, never as "screened, nothing found".
    const approvalRow = await getPendingApproval(e.approvalId);
    const card = await storeWebchatApprovalCard(roomId, e.agentName ?? 'agent', {
      questionId: e.approvalId,
      title: e.title,
      question: e.question,
      options: e.options,
      action: e.action,
      approvers: e.approvers,
      triage: await buildApprovalTriageView(e.approvalId, e.action, approvalRow?.payload ?? ''),
    });
    await recordWebchatApproval(e.approvalId, roomId);
    await broadcast(roomId, { type: 'message', ...(await card) });
  }),
);

// Learning loop: when an agent proposes a skill, drop an actionable card into
// ITS OWN room — that's where the work happened, so that's where the operator
// should be able to Keep/Discard it (rather than hunting in the Skills tab).
// Best-effort; webchat rooms only.
registerSkillDraftProposedListener(async (e) => {
  const mg = await (e.session.messaging_group_id ? getMessagingGroup(e.session.messaging_group_id) : null);
  if (!mg || mg.channel_type !== 'webchat') return;
  const roomId = mg.platform_id;
  const card = await storeWebchatSkillDraftCard(
    roomId,
    e.agentName,
    {
      draftId: e.draftId,
      skillName: e.skillName,
      description: e.description,
      kind: e.kind,
      targetSkill: e.targetSkill,
      agentGroupId: e.agentGroupId,
      agentName: e.agentName,
    },
    // Session key → UI thread, as the reply path does (no phantom threads).
    await sessionKeyToThread(e.session.thread_id, roomId),
  );
  await broadcast(roomId, { type: 'message', ...(await card) });
});

// Auto-keep (or any non-webchat resolution) still flips the in-room card, so
// the room shows '✅ … kept' instead of dangling actionable buttons for a
// draft that no longer exists.
registerSkillDraftResolvedListener(async (e) => {
  const flipped = await markRoomSkillDraftResolved(e.draftId, e.outcome, e.by);
  if (flipped) await broadcast(flipped.roomId, { type: 'message', ...flipped.message });
});

/**
 * Draft expiry: a pending draft self-discards only when BOTH are true —
 * it's older than 24h, AND its in-room card has scrolled out of the chat
 * (enough newer messages that nobody opening the room sees it). A card still
 * in view stays actionable forever; age alone never kills something a human
 * might be looking at. Drafts with no card at all (non-webchat) expire on age.
 * Discard deletes only the draft — nothing else — so the worst case of a wrong
 * expiry is re-running /learn.
 */
export const DRAFT_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const DRAFT_SCROLLED_AWAY_MESSAGES = 30;

export function draftHasExpired(ageMs: number, card: { newerMessages: number } | null): boolean {
  if (ageMs < DRAFT_EXPIRY_MS) return false;
  if (card === null) return true; // no card anywhere — nothing keeps it in view
  return card.newerMessages >= DRAFT_SCROLLED_AWAY_MESSAGES;
}

export async function sweepExpiredSkillDrafts(): Promise<number> {
  let expired = 0;
  for (const d of await listSkillDrafts()) {
    const age = Date.now() - d.created_at;
    if (!draftHasExpired(age, await skillDraftCardPosition(d.id))) continue;
    if (!(await resolveSkillDraft(d.id, 'discarded'))) continue;
    expired++;
    const flipped = await markRoomSkillDraftResolved(d.id, 'discarded', 'expired');
    if (flipped) await broadcast(flipped.roomId, { type: 'message', ...flipped.message });
    log.info('Skill draft expired', { id: d.id, skill: d.skill_name, ageHours: Math.round(age / 3_600_000) });
  }
  return expired;
}

let draftExpiryTimer: ReturnType<typeof setInterval> | null = null;
let activityPruneTimer: ReturnType<typeof setInterval> | undefined;
let mcpHealthTimer: ReturnType<typeof setInterval> | null = null;
