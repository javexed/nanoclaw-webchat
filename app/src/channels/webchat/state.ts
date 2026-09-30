/**
 * Webchat in-memory client registry + broadcast.
 *
 * Tracks connected WS clients per room, fans out broadcasts, and triggers
 * Web Push to offline subscribers. Message bodies are redacted before they
 * leave the host. Room-list changes are broadcast by the routes that make
 * them: there is no central group-change event.
 */
import { WebSocket } from 'ws';

import { log } from '../../log.js';
import { canArchiveRoom, filterRoomsForUser } from './access.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  getAllWebchatRooms,
  getArchivedRoomIds,
  getHiddenRoomIdsForUser,
  getSharedWebchatRooms,
  getMentionedRoomIdsForUser,
  getPinnedPositionsForUser,
  getRoomLastActivity,
  getTopicThreadCounts,
  getUnreadRoomIdsForUser,
  getWebchatRoom,
  getWebchatUserHandle,
  markRoomRead,
  resolveHandlesToUserIds,
  storeWebchatA2aMessage,
  type WebchatRoom,
} from './db.js';
import { sendPushForMessage } from './push.js';
import { redactSensitiveData } from './redact.js';

export interface WSClient {
  id: string;
  ws: WebSocket;
  /** Display name shown in the chat. Equals `userId` when no separate name. */
  identity: string;
  identity_type: 'user' | 'agent';
  /**
   * v2-namespaced user id (`webchat:owner`, `webchat:tailscale:<email>`, ...).
   * Threaded into inbound message content as `senderId` so the permissions
   * module's senderResolver can upsert the users row and gate access.
   */
  userId: string;
  room_id?: string;
  /** Thread currently open for this client (default 'main'); set on join. */
  thread_id?: string;
  isAlive: boolean;
}

export const clients = new Map<string, WSClient>();

export function addClient(c: WSClient): void {
  clients.set(c.id, c);
}

export function removeClient(id: string): WSClient | undefined {
  const c = clients.get(id);
  clients.delete(id);
  return c;
}

interface MemberInfo {
  identity: string;
  identity_type: 'user' | 'agent';
  /** Human members' @-mention handle, for the client's @ autocomplete. */
  handle?: string;
}

// Tracked separately from `clients` because the agent isn't a WS client —
// the channel adapter's setTyping() flips its presence flag.
const activeAgents = new Map<string, string>(); // roomId -> agent identity

export async function getMemberList(roomId: string): Promise<MemberInfo[]> {
  const seen = new Set<string>();
  const members: MemberInfo[] = [];
  for (const c of clients.values()) {
    if (c.room_id === roomId && !seen.has(c.identity)) {
      seen.add(c.identity);
      members.push({
        identity: c.identity,
        identity_type: c.identity_type,
        handle: (await getWebchatUserHandle(c.userId)) ?? undefined,
      });
    }
  }
  const agentIdentity = activeAgents.get(roomId);
  if (agentIdentity && !seen.has(agentIdentity)) {
    members.push({ identity: agentIdentity, identity_type: 'agent' });
  }
  return members;
}

/** Extract @-mention handle tokens (`@alice`) from message text, lowercased. */
export function extractHandles(text: string): string[] {
  const re = /(?:^|[^a-z0-9_-])@([a-z0-9-]{1,32})/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].toLowerCase());
  return out;
}

// ── Active agent turns (for thinking-bubble replay on room re-join) ─────────
// Status frames reach only clients in the room at the time, so a re-join
// replays a synthetic `start` from this roomId → agent-names map (start adds;
// done/stalled removes).
const activeTurns = new Map<string, Set<string>>();

export function recordTurnStart(roomId: string, agentName: string): void {
  let set = activeTurns.get(roomId);
  if (!set) activeTurns.set(roomId, (set = new Set()));
  set.add(agentName);
}

export function recordTurnEnd(roomId: string, agentName: string): void {
  const set = activeTurns.get(roomId);
  if (!set) return;
  set.delete(agentName);
  if (set.size === 0) activeTurns.delete(roomId);
}

/** Agent names with an open turn in this room — replayed to a joining client. */
export function getActiveTurns(roomId: string): string[] {
  return [...(activeTurns.get(roomId) ?? [])];
}

/** Anything that mirrors a room outside the PWA socket (a laptop's chat view over the runner link). Gets the REDACTED message. */
const roomMessageSubscribers = new Set<(roomId: string, msg: Record<string, unknown>) => void>();
export function onRoomMessage(cb: (roomId: string, msg: Record<string, unknown>) => void): () => void {
  roomMessageSubscribers.add(cb);
  return () => roomMessageSubscribers.delete(cb);
}
/** Hand an already-redacted room message to the mirrors. `broadcast` calls this; tests may too. */
export function notifyRoomMessage(roomId: string, msg: Record<string, unknown>): void {
  for (const cb of roomMessageSubscribers) {
    try {
      cb(roomId, msg);
    } catch (err) {
      log.warn('Webchat: room message subscriber threw', { roomId, err });
    }
  }
}

/**
 * Agent activity (`status` frames: start / tool / progress / reasoning / done /
 * stalled) for mirrors that are not websocket clients — the VS Code chat view.
 * The frames are already redacted by the adapter that emits them.
 */
const roomStatusSubscribers = new Set<(roomId: string, msg: Record<string, unknown>) => void>();
export function onRoomStatus(cb: (roomId: string, msg: Record<string, unknown>) => void): () => void {
  roomStatusSubscribers.add(cb);
  return () => roomStatusSubscribers.delete(cb);
}
export function notifyRoomStatus(roomId: string, msg: Record<string, unknown>): void {
  for (const cb of roomStatusSubscribers) {
    try {
      cb(roomId, msg);
    } catch (err) {
      log.warn('Webchat: room status subscriber threw', { roomId, err });
    }
  }
}

export async function broadcast(roomId: string, msg: object, excludeId?: string): Promise<void> {
  const isMessage = (msg as { type?: string }).type === 'message';
  if ((msg as { type?: string }).type === 'status') notifyRoomStatus(roomId, msg as Record<string, unknown>);
  const outgoing = isMessage
    ? { ...msg, content: redactSensitiveData((msg as { content?: string }).content || '') }
    : msg;
  if (isMessage) notifyRoomMessage(roomId, outgoing as Record<string, unknown>);
  const payload = JSON.stringify(outgoing);
  const notifyPayload = isMessage ? JSON.stringify({ type: 'unread', room_id: roomId }) : '';

  // A mentioned user outside the room gets a `mention` signal instead of a plain
  // unread (redaction never touches @handles); in-room clients detect their own
  // mentions. Web Push stays generic: subscriptions are keyed by display name.
  const mentionedUserIds = isMessage
    ? new Set(await resolveHandlesToUserIds(extractHandles((msg as { content?: string }).content || '')))
    : new Set<string>();
  const mentionPayload = JSON.stringify({ type: 'mention', room_id: roomId });

  let inRoom = 0;
  let elsewhere = 0;
  for (const c of clients.values()) {
    if (c.id === excludeId || c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      if (c.room_id === roomId) {
        inRoom += 1;
        c.ws.send(payload);
      } else if (isMessage) {
        elsewhere += 1;
        c.ws.send(mentionedUserIds.has(c.userId) ? mentionPayload : notifyPayload);
      }
    } catch {
      // Socket may have closed between readyState check and send — ignore.
    }
  }
  // Nobody in the room while clients are connected: the signature of a sender
  // socket tracking another room ("saw nothing until I switched back").
  if (isMessage && inRoom === 0 && elsewhere > 0) {
    log.warn('Webchat: message broadcast with no client in the room', { roomId, clientsElsewhere: elsewhere });
  }

  // Side-channel a2a copies and in-room approval cards fan out to open tabs
  // (above) but don't push-notify here — a2a is agent chatter, and approvals
  // get their own delivery to approver inboxes.
  if (
    isMessage &&
    !['a2a', 'approval', 'approval_resolved'].includes((msg as { message_type?: string }).message_type ?? '')
  ) {
    const m = msg as { sender?: string; content?: string; id?: string };
    const room = await getWebchatRoom(roomId);
    await sendPushForMessage({
      roomId,
      roomName: room?.name || roomId,
      sender: m.sender || 'unknown',
      // Subscriptions are keyed by user id; `sender` is a display name.
      senderUserId: excludeId ? clients.get(excludeId)?.userId : undefined,
      content: redactSensitiveData(m.content || ''),
      messageId: m.id,
    }).catch((err) => log.warn('sendPushForMessage failed', { err: err instanceof Error ? err.message : err }));
  }
}

/**
 * Surface an a2a message, after delivery, into every webchat room both agents
 * share as a read-only copy. Only the text of `contentJson` (`{"text": …}`) is
 * shown; self-messages (from === to) and empty text are skipped. The caller
 * swallows failures so routing never blocks.
 */
export async function surfaceA2aMessage(
  fromAgentGroupId: string,
  toAgentGroupId: string,
  contentJson: string,
): Promise<void> {
  if (fromAgentGroupId === toAgentGroupId) return;

  let text = '';
  try {
    const parsed = JSON.parse(contentJson) as { text?: unknown };
    if (typeof parsed.text === 'string') text = parsed.text;
  } catch {
    // Non-JSON content — fall back to the raw string.
    text = contentJson;
  }
  text = text.trim();
  if (!text) return;

  const rooms = await getSharedWebchatRooms(fromAgentGroupId, toAgentGroupId);
  if (rooms.length === 0) return;

  const fromName = (await getAgentGroup(fromAgentGroupId))?.name ?? fromAgentGroupId;
  const toName = (await getAgentGroup(toAgentGroupId))?.name ?? toAgentGroupId;

  for (const room of rooms) {
    const stored = await storeWebchatA2aMessage(room.id, fromName, toName, text);
    await broadcast(room.id, { type: 'message', ...(await stored) });
  }
}

/** Send a payload to every connected client of `userId`, whatever room; returns the count. */
export function pushToUser(userId: string, msg: object): number {
  const payload = JSON.stringify(msg);
  let sent = 0;
  for (const c of clients.values()) {
    if (c.userId !== userId) continue;
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      c.ws.send(payload);
      sent++;
    } catch {
      // Socket may have closed between readyState check and send — ignore.
    }
  }
  return sent;
}

/**
 * Push an `approval` event (the ask_question payload). An offline approver is
 * only logged: the PWA refetches /api/approvals/pending on connect.
 */
export function pushApprovalToUser(userId: string, askQuestionPayload: Record<string, unknown>): void {
  const sent = pushToUser(userId, { type: 'approval', ...askQuestionPayload });
  if (sent === 0) {
    log.info('Webchat approval queued for offline user', { userId });
  }
}

/**
 * Push a typed `approval_resolved` event so a connected PWA can hide a fan-out
 * card another admin already handled. Offline users are covered by the PWA's
 * refetch on reconnect (the row is gone), so this is purely the live clear.
 */
export function pushApprovalResolvedToUser(userId: string, approvalId: string, resolvedByUserId: string): void {
  pushToUser(userId, { type: 'approval_resolved', approvalId, resolvedBy: resolvedByUserId });
}

/**
 * Annotate the room list with one user's sidebar flags (archived, hidden,
 * canArchive, unread). Shared by the auth-time send (ws.ts) and broadcastRooms
 * so both carry identical metadata.
 */
export async function annotateRoomsForUser(
  userId: string,
  // Resolved below when omitted (a default cannot await); broadcastRooms passes
  // them to compute once across all clients.
  allRoomsIn?: WebchatRoom[],
  archivedSetIn?: Set<string>,
  activityMapIn?: Map<string, number>,
  threadCountsIn?: Map<string, number>,
): Promise<
  Array<
    WebchatRoom & {
      archived: boolean;
      hidden: boolean;
      canArchive: boolean;
      unread: boolean;
      mention: boolean;
      pinned: boolean;
      pin_position: number | null;
      last_activity: number;
      thread_count: number;
    }
  >
> {
  const allRooms = allRoomsIn ?? (await getAllWebchatRooms());
  const archivedSet = archivedSetIn ?? (await getArchivedRoomIds());
  const activityMap = activityMapIn ?? (await getRoomLastActivity());
  const threadCounts = threadCountsIn ?? (await getTopicThreadCounts());
  const visible = await filterRoomsForUser(userId, allRooms);
  const hiddenSet = await getHiddenRoomIdsForUser(userId); // per-user
  const unreadSet = await getUnreadRoomIdsForUser(userId); // per-user
  const mentionSet = await getMentionedRoomIdsForUser(userId, (await getWebchatUserHandle(userId)) ?? ''); // per-user
  const pinnedPos = await getPinnedPositionsForUser(userId); // per-user: room → manual order
  return Promise.all(
    visible.map(async (r) => ({
      ...r,
      archived: archivedSet.has(r.id),
      hidden: hiddenSet.has(r.id),
      canArchive: await canArchiveRoom(userId, r.id),
      unread: unreadSet.has(r.id),
      mention: mentionSet.has(r.id),
      pinned: pinnedPos.has(r.id),
      // Manual pin order (lower = higher); null when unpinned. The client sorts the
      // pinned group by this instead of recent activity.
      pin_position: pinnedPos.get(r.id) ?? null,
      // Newest-message time drives the "Recent" sort; fall back to created_at.
      last_activity: activityMap.get(r.id) ?? r.created_at,
      // Topic-thread count — drives the sidebar expand chevron.
      thread_count: threadCounts.get(r.id) ?? 0,
    })),
  );
}

/**
 * Push the current room list to every connected client, filtered per client by
 * `canAccessRoom` here so no caller has to thread userId. Called by the routes
 * that change rooms; external messaging_groups changes are not detected.
 */
export async function broadcastRooms(): Promise<void> {
  const allRooms = await getAllWebchatRooms();
  const archivedSet = await getArchivedRoomIds(); // global, computed once per broadcast
  const activityMap = await getRoomLastActivity(); // global, computed once per broadcast
  const threadCounts = await getTopicThreadCounts(); // global, computed once per broadcast
  for (const c of clients.values()) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    c.ws.send(
      JSON.stringify({
        type: 'rooms',
        rooms: await annotateRoomsForUser(
          c.userId,
          await allRooms,
          await archivedSet,
          await activityMap,
          await threadCounts,
        ),
      }),
    );
  }
}

/**
 * Advance a user's read marker and push `read_cleared` to their OTHER clients,
 * so the dot clears on every device (the originating client is skipped).
 */
export function markRoomReadForUser(userId: string, roomId: string, ts: number, originClientId?: string): void {
  markRoomRead(userId, roomId, ts).catch((err) =>
    log.warn('markRoomRead failed', { userId, roomId, err: String(err) }),
  );
  const payload = JSON.stringify({ type: 'read_cleared', room_id: roomId });
  for (const c of clients.values()) {
    if (c.userId !== userId || c.id === originClientId) continue;
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      c.ws.send(payload);
    } catch {
      // Socket may have closed between readyState check and send — ignore.
    }
  }
}
