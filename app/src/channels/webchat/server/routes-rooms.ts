// ── Room routes ──────────────────────────────────────────────────────────────
// Everything addressed at a room: create and delete, the agents wired into it,
// its threads and their context sync, prime state, and room import (upload,
// then apply).
//
// What the room routes share with routes outside this cluster lives in
// server/agent-wiring.ts and server/archive.ts — see the notes there.
import type { IncomingMessage, ServerResponse } from 'http';

import { json, readJsonBody } from './http.js';
import { DATA_DIR, GROUPS_DIR } from '../../../config.js';
import { restartAgentGroupContainers } from '../../../container-restart.js';
import { deleteAgentGroup, getAgentGroup } from '../../../db/agent-groups.js';
import { getDb } from '../../../db/connection.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../../db/container-configs.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../../db/sessions.js';
import { log } from '../../../log.js';
import { getRoomLearning, setRoomLearning } from '../../../modules/learning/room-settings.js';
import {
  applyRoomImport,
  isSafeRoomEntry,
  previewRoomImport,
  roomTarArgs,
  stageRoomExport,
} from '../../../modules/transfer/room-transfer.js';
import { syncSessionContext } from '../../../session-manager.js';
import type { ContextMessage } from '../../../session-manager.js';
import {
  deleteSessionDbState,
  findSessionsByMessagingGroup,
  findSessionsByMessagingGroupThread,
  teardownSessionResources,
} from '../../../session-teardown.js';
import type { TeardownTarget } from '../../../session-teardown.js';
import { canAccessRoom, canArchiveRoom, filterRoomsForUser } from '../access.js';
import {
  MAIN_THREAD,
  archiveRoom,
  clearPrimeAgentForWebchatRoom,
  countAgentsForWebchatRoom,
  createWebchatRoom,
  createWebchatThread,
  deleteWebchatRoom,
  deleteWebchatThread,
  ensureMainThread,
  getAgentsForWebchatRoom,
  getAllWebchatRooms,
  getArchivedRoomIds,
  getCredentialsConfig,
  getEffectiveRoomMode,
  getHiddenRoomIdsForUser,
  getPrimeAgentForWebchatRoom,
  getRoomEngageDefault,
  getRoomModeOverride,
  getRoomOauthAllowed,
  getSyncDelta,
  getThreadSyncMarks,
  getUnreadThreadIdsForRoom,
  getWebchatHandleUsers,
  getWebchatRoom,
  getWebchatThread,
  hideRoomForUser,
  insertSyncedMessages,
  listWebchatThreads,
  markThreadRead,
  pinRoomForUser,
  renameWebchatThread,
  sanitizeRoomName,
  sanitizeThreadTitle,
  setPinnedOrderForUser,
  setPrimeAgentForWebchatRoom,
  setRoomEngageDefault,
  setRoomModeOverride,
  setRoomOauthAllowed,
  setThreadSyncMark,
  threadToSessionKey,
  unarchiveRoom,
  unhideRoomForUser,
  unpinRoomForUser,
  unwireAgentFromWebchatRoom,
  updateWebchatRoomName,
} from '../db.js';
import type { WebchatRoomAgent } from '../db.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../roles.js';
import {
  SESSION_COMMANDS,
  createBareAgentGroup,
  injectSessionCommand,
  nameToFolder,
  parseAgentLearning,
  recomputeEngagePatterns,
  wireAgentToWebchatRoom,
} from './agent-wiring.js';
import { pendingAgentImports, spawnTar, spoolUploadToTmp, sweepPendingImports } from './archive.js';
import { availableProviders } from './providers.js';
import { broadcast, broadcastRooms } from '../state.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RouteCtx } from '../server.js';
import { everyAsync, filterAsync, someAsync } from '../async-array.js';

// ── Rooms ─────────────────────────────────────────────────────────────
// Two creation paths exist for historical reasons and they are NOT
// redundant: POST /api/agents is "agent-first" (the room is incidental,
// 1:1 with the agent's folder), POST /api/rooms is "room-first" (the
// room is the conversation unit and you wire 1+ agents to it). Both
// converge on the same messaging_groups + messaging_group_agents shape.
export async function rRoomsGet(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const visible = await filterRoomsForUser(userId, await getAllWebchatRooms());
  const archivedSet = await getArchivedRoomIds(); // global
  const hiddenSet = await getHiddenRoomIdsForUser(userId); // per-user
  return json(
    res,
    200,
    await Promise.all(
      visible.map(async (r) => ({
        ...r,
        archived: archivedSet.has(r.id),
        hidden: hiddenSet.has(r.id),
        canArchive: await canArchiveRoom(userId, r.id),
      })),
    ),
  );
}

export async function rRoomsPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  return createRoomHandler(req, res);
}

export async function rRoomIdDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return deleteRoomHandler(res, decodeURIComponent(m[1]));
}

export async function rRoomAgentsGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  const agents = await getAgentsForWebchatRoom(roomId);
  const primeAgentId = await getPrimeAgentForWebchatRoom(roomId);
  // Promise.all around the map: the callback is async (learning_auto reads
  // the DB), so without it `json` would serialize an array of Promises —
  // which stringify as {} and hand the client a room full of empty agents.
  return json(
    res,
    200,
    await Promise.all(
      agents.map(async (a) => ({
        ...a,
        is_prime: a.id === primeAgentId,
        // Whether this agent auto-runs the learning review after busy turns.
        // Member-visible on purpose: the client uses it to suppress the manual
        // nudge (auto already ran — a tap would just double the review).
        learning_auto: (await parseAgentLearning(a.id)).autoTrigger !== false,
      })),
    ),
  );
}

// People you can @-mention in this room: anyone with a handle who can access
// it (NOT limited to who's currently connected — a mention notifies on
// return). Excludes the requester. Used by the composer's @ autocomplete.
export async function rRoomMentionableGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  const people = (
    await filterAsync(
      await getWebchatHandleUsers(),
      async (u) => u.userId !== userId && (await canAccessRoom(u.userId, roomId)),
    )
  ).map((u) => ({ handle: u.handle, name: u.displayName || u.handle }));
  return json(res, 200, people);
}

export async function rRoomAgentsPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  // Permission is body-dependent (which agent is being wired), so it is
  // enforced inside the handler once the AgentRef is parsed. Owners may wire
  // anything; a scoped admin may wire an agent THEY administer to a room
  // they can access.
  return addAgentToRoomHandler(req, res, decodeURIComponent(m[1]), userId);
}

// ── UserCreds: per-room credential mode (admin) ────────────────────────────────
export async function rRoomCredModeGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  // The per-room OVERRIDE ('inherit' when unset); the effective mode is what the
  // room actually runs (override, else the global default).
  return json(res, 200, {
    mode: getRoomModeOverride(roomId) ?? 'inherit',
    effectiveMode: await getEffectiveRoomMode(roomId),
    defaultMode: (await getCredentialsConfig()).defaultMode,
  });
}

export async function rRoomCredModePut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  // Owner, or an admin over ANY agent wired to this room.
  const allowed =
    (await isOwner(userId)) ||
    (await someAsync(await getAgentsForWebchatRoom(roomId), (a) => hasAdminPrivilege(userId, a.id)));
  if (!allowed) return json(res, 403, { error: 'Admin privilege required' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { mode?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (body.mode !== 'inherit' && body.mode !== 'disabled' && body.mode !== 'optional' && body.mode !== 'required') {
    return json(res, 400, { error: "mode must be 'inherit', 'disabled', 'optional', or 'required'" });
  }
  // 'inherit' clears the override so the room follows the global default.
  await setRoomModeOverride(roomId, body.mode === 'inherit' ? null : body.mode);
  return json(res, 200, { ok: true, mode: body.mode });
}

// ── UserCreds OAuth: per-room toggle allowing subscription tokens (admin) ───────
export async function rRoomOauthGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  return json(res, 200, { allowed: await getRoomOauthAllowed(roomId) });
}

export async function rRoomOauthPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  const allowed =
    (await isOwner(userId)) ||
    (await someAsync(await getAgentsForWebchatRoom(roomId), (a) => hasAdminPrivilege(userId, a.id)));
  if (!allowed) return json(res, 403, { error: 'Admin privilege required' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { allowed?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.allowed !== 'boolean') return json(res, 400, { error: 'allowed must be a boolean' });
  await setRoomOauthAllowed(roomId, body.allowed);
  return json(res, 200, { ok: true, allowed: body.allowed });
}

export async function rRoomAgentDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  const agentId = decodeURIComponent(m[2]);
  // Owner can unwire any agent. A scoped admin may unwire an agent THEY
  // administer from a room they can access — they can never touch agents
  // they don't administer.
  if (!(await isOwner(userId)) && !((await canAccessRoom(userId, roomId)) && (await hasAdminPrivilege(userId, agentId)))) {
    return json(res, 403, { error: 'Admin privilege required' });
  }
  return removeAgentFromRoomHandler(res, roomId, agentId);
}

// ── Prime agent designation (room-scoped) ──
export async function rRoomPrimePut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const roomId = decodeURIComponent(m[1]);
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { agentId?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.agentId !== 'string' || !body.agentId.trim()) {
    return json(res, 400, { error: 'agentId required' });
  }
  return setRoomPrimeHandler(res, roomId, body.agentId.trim());
}

export async function rRoomPrimeDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  return clearRoomPrimeHandler(res, decodeURIComponent(m[1]));
}

// ── Global archive (owner + admin) ──
// Marks the room as closed-to-active-work for EVERYONE. Owners + any
// admin (global or scoped admin of an agent wired to the room) can
// toggle. Archive is presentation only — routing continues unchanged.
// CSRF-guarded because it's a state-mutating POST.
export async function rRoomArchivePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canArchiveRoom(userId, roomId))) return json(res, 403, { error: 'Admin only' });
  if (m[2] === 'archive') {
    await archiveRoom(roomId, userId);
  } else {
    await unarchiveRoom(roomId);
  }
  await broadcastRooms();
  return json(res, 200, { ok: true });
}

// ── Per-user hide (sidebar preference, no auth beyond room access) ──
// Any user with access to the room can hide it from THEIR sidebar.
// Doesn't affect anyone else, routing, archive state, or anything
// beyond that user's view. CSRF-guarded because it's state-mutating.
export async function rRoomHidePost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  if (m[2] === 'hide') {
    await hideRoomForUser(userId, roomId);
  } else {
    await unhideRoomForUser(userId, roomId);
  }
  await broadcastRooms();
  return json(res, 200, { ok: true });
}

// ── Per-user pin (sidebar preference, no auth beyond room access) ──
// Pins lift a room into the sticky group at the top of THIS user's sidebar.
// Per-user; broadcastRooms re-sends each user their own annotated list, so the
// pin syncs live across the user's other devices.
export async function rRoomPinPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  if (m[2] === 'pin') {
    await pinRoomForUser(userId, roomId);
  } else {
    await unpinRoomForUser(userId, roomId);
  }
  await broadcastRooms();
  return json(res, 200, { ok: true });
}

// Reorder the caller's pinned rooms. Body: { order: string[] } — the desired
// top-to-bottom room-id order. Per-user (setPinnedOrderForUser only touches
// this user's pins; unknown/unpinned ids are ignored), so no per-room access
// check is needed beyond the authenticated user. broadcastRooms re-syncs the
// new order to the user's other devices.
export async function rRoomsPinsOrderPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { order?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (!Array.isArray(body.order) || body.order.some((x) => typeof x !== 'string')) {
    return json(res, 400, { error: 'order must be an array of room id strings' });
  }
  await setPinnedOrderForUser(userId, body.order as string[]);
  await broadcastRooms();
  return json(res, 200, { ok: true });
}

// ── Engage mode (room-scoped) ──
// Controls what `recomputeEngagePatterns` rewrites un-primed wirings to:
//   'mention-only' — agents fire only on explicit @-mention (no fallback).
// This is the only mode; the legacy 'broadcast' (every wired agent answers
// every message) has been retired.
export async function rRoomEngageGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  return json(res, 200, { mode: getRoomEngageDefault(roomId) });
}

export async function rRoomEngagePut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { mode?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (body.mode !== 'mention-only') {
    return json(res, 400, { error: "mode must be 'mention-only'" });
  }
  await setRoomEngageDefault(roomId, body.mode);
  // Re-run pattern computation so the new mode is reflected in every wiring.
  // No-op when a prime is set (prime branch takes over). Cheap one-UPDATE-per-wiring.
  await recomputeEngagePatterns(roomId);
  await broadcastRooms();
  return json(res, 200, { ok: true, mode: body.mode });
}

// Rename a room (its messaging_groups.name). Owner-only; broadcastRooms pushes
// the new title to every connected client live.
export async function rRoomNamePut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const name = sanitizeRoomName(body.name);
  if (name === null) return json(res, 400, { error: 'name must be 1–80 characters' });
  await updateWebchatRoomName(roomId, name);
  await broadcastRooms();
  return json(res, 200, { ok: true, name });
}

// ── Threads (per-room) ────────────────────────────────────────────────
// A thread maps to an agent session; see docs/webchat/threads.md.
// List/read/create/rename are member-gated; delete (destroys history + tears
// down the thread's session) is owner-only.
export async function rRoomThreadReadPut(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  const threadId = decodeURIComponent(m[2]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  await markThreadRead(userId, roomId, threadId);
  return json(res, 200, { ok: true });
}

export async function rRoomThreadsGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  await ensureMainThread(roomId); // every room has a main thread once listed
  const unread = await getUnreadThreadIdsForRoom(userId, roomId);
  return json(
    res,
    200,
    (await listWebchatThreads(roomId)).map((t) => ({ ...t, unread: unread.has(t.thread_id) })),
  );
}

export async function rRoomThreadsPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { title?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const title = sanitizeThreadTitle(body.title);
  if (title === null) return json(res, 400, { error: 'title must be 1–80 characters' });
  const thread = createWebchatThread(roomId, title);
  await broadcastRooms(); // refresh each client's sidebar thread-count chevron
  return json(res, 200, thread);
}

export async function rRoomThreadPatch(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  const threadId = decodeURIComponent(m[2]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  if (!(await getWebchatThread(roomId, threadId))) return json(res, 404, { error: 'Thread not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { title?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const title = sanitizeThreadTitle(body.title);
  if (title === null) return json(res, 400, { error: 'title must be 1–80 characters' });
  await renameWebchatThread(roomId, threadId, title);
  return json(res, 200, { ok: true, title });
}

export async function rRoomThreadDelete(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res } = ctx;
  const roomId = decodeURIComponent(m[1]);
  const threadId = decodeURIComponent(m[2]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (threadId === 'main') return json(res, 400, { error: 'The main thread cannot be deleted' });
  if (!(await getWebchatThread(roomId, threadId))) return json(res, 404, { error: 'Thread not found' });
  return deleteThreadHandler(res, roomId, threadId);
}

// ── Thread context sync (pull main → thread / push thread → main) ──
// Both are verbatim + additive: copy the source's native message delta into
// the destination, seed the destination agent session(s) as silent context,
// broadcast the copies, and advance the per-thread high-water mark so repeat
// syncs only carry genuinely new messages. The 'main' regular chat is the
// shared trunk; only a topic thread can pull from / push to it.
// See docs/webchat/thread-context-sync.md.
export async function rRoomThreadPullPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  const threadId = decodeURIComponent(m[2]);
  const dir = m[3] as 'pull' | 'push';
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  if (!(await canAccessRoom(userId, roomId))) return json(res, 403, { error: 'Access denied' });
  if (threadId === MAIN_THREAD) return json(res, 400, { error: 'The regular chat has no main to sync with' });
  if (!(await getWebchatThread(roomId, threadId))) return json(res, 404, { error: 'Thread not found' });
  const copied =
    dir === 'pull'
      ? syncThreadContext({
          roomId,
          srcThreadId: MAIN_THREAD,
          destThreadId: threadId,
          markThreadId: threadId,
          direction: 'pulled',
          dividerText: 'Pulled from main chat',
          freshLimit: FRESH_SYNC_LIMIT,
        })
      : syncThreadContext({
          roomId,
          srcThreadId: threadId,
          destThreadId: MAIN_THREAD,
          markThreadId: threadId,
          direction: 'pushed',
          dividerText: 'Pushed from thread',
          freshLimit: FRESH_SYNC_LIMIT,
        });
  return json(res, 200, { copied });
}

// Learning-loop settings, per agent. Two toggles, two owners (docs/webchat/learning-loop.md):
//   autoTrigger — spends tokens, stages drafts → per-agent ADMIN.
//   autoKeep    — writes live agent context unreviewed → OWNER/GLOBAL ADMIN only,
//                 the same boundary as every other skill write.
// Per-ROOM learning settings — the layer the 🎓 menu edits. Room overrides
// the wired agents' per-agent config; the effective view resolves
// room → first wired agent → defaults, so the toggles show what will
// actually happen in THIS room.
export async function rRoomLearning(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, method, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return json(res, 404, { error: 'Room has no messaging group' });
  const wired = (await getMessagingGroupAgents(mg.id)).map((w) => ({ id: w.agent_group_id }));
  // Both toggles spend or commit on the wired agents' behalf — admin over
  // every one of them (a room is only as governable as its least-governed
  // agent).
  const canManage = wired.length > 0 && (await everyAsync(wired, (a) => hasAdminPrivilege(userId, a.id)));
  const room = await getRoomLearning(mg.id);
  const agentFallback = wired.length > 0 ? await parseAgentLearning(wired[0].id) : {};
  const effective = {
    autoTrigger: room.autoTrigger ?? agentFallback.autoTrigger !== false,
    autoKeep: room.autoKeep ?? agentFallback.autoKeep === true,
  };
  if (method === 'GET') {
    return json(res, 200, { ...effective, canManage, roomOverride: room });
  }
  if (!canManage) return json(res, 403, { error: 'Admin privilege over every wired agent required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { autoTrigger?: unknown; autoKeep?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  // Boolean sets the room override; explicit null CLEARS it (back to the
  // agent-level default) — JSON.stringify drops undefined keys on save.
  const patch: { autoTrigger?: boolean; autoKeep?: boolean } = {};
  if (typeof body.autoTrigger === 'boolean' || body.autoTrigger === null) {
    patch.autoTrigger = body.autoTrigger ?? undefined;
  }
  if (typeof body.autoKeep === 'boolean' || body.autoKeep === null) {
    patch.autoKeep = body.autoKeep ?? undefined;
  }
  const next = await setRoomLearning(mg.id, patch);
  // Auto-trigger lives in the CONTAINER config (rooms map) — respawn the
  // wired agents so their next turn sees it. Auto-keep is host-side and
  // needs no restart, but the map rides along anyway.
  let restarted = 0;
  for (const a of wired) restarted += await restartAgentGroupContainers(a.id, 'Room learning settings changed');
  return json(res, 200, {
    autoTrigger: next.autoTrigger ?? agentFallback.autoTrigger !== false,
    autoKeep: next.autoKeep ?? agentFallback.autoKeep === true,
    canManage,
    roomOverride: next,
    restarted,
  });
}

// ── Room export/import (backup Phase 3) ───────────────────────────────
export async function rRoomExportGet(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { res, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Global admin required' });
  const roomId = decodeURIComponent(m[1]);
  if (!(await getWebchatRoom(roomId))) return json(res, 404, { error: 'Room not found' });
  let staged: { stage: string };
  try {
    staged = await stageRoomExport(roomId);
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="nanoclaw-room-${roomId}-${new Date().toISOString().slice(0, 10)}.tgz"`,
  });
  const tar = spawnTar(roomTarArgs(staged.stage, roomId));
  tar.stdout?.pipe(res);
  tar.on('close', (code: number) => {
    fs.rmSync(staged.stage, { recursive: true, force: true });
    if (code !== null && code >= 2) res.destroy();
    else res.end();
  });
  res.on('close', () => tar.kill('SIGTERM'));
  return;
}

export async function rRoomsImportPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return importRoomUploadHandler(req, res);
}

export async function rRoomsImportApplyPost(ctx: RouteCtx, _m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  if (!(await isOwner(userId)) && !(await isGlobalAdmin(userId))) return json(res, 403, { error: 'Global admin required' });
  if (req.headers['x-webchat-csrf'] !== '1') return json(res, 403, { error: 'Missing X-Webchat-CSRF header' });
  return importRoomApplyHandler(req, res);
}

// Bulk: inject a command (/clear or /compact) into every active session of
// every agent wired to a room — the "/clear all" / "/compact all" fan-out.
// Resolves the room's agents server-side, and only touches agents the caller
// has admin over (incl. their background a2a sessions).
export async function rRoomBroadcastPost(ctx: RouteCtx, m: RegExpMatchArray): Promise<void> {
  const { req, res, userId } = ctx;
  const roomId = decodeURIComponent(m[1]);
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let command = '';
  try {
    command = String((JSON.parse(raw) as { command?: unknown }).command || '');
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (!SESSION_COMMANDS.has(command)) return json(res, 400, { error: 'command must be /clear or /compact' });
  const agents = await filterAsync(await getAgentsForWebchatRoom(roomId), (a) => hasAdminPrivilege(userId, a.id));
  if (agents.length === 0) return json(res, 403, { error: 'Admin privilege required' });
  let count = 0;
  for (const a of agents) {
    for (const s of (await getSessionsByAgentGroup(a.id)).filter((x) => x.status === 'active')) {
      try {
        injectSessionCommand(a.id, s.id, command);
        count++;
      } catch {
        /* skip sessions whose inbound.db is missing */
      }
    }
  }
  return json(res, 200, { ok: true, count });
}

/**
 * Cap on the *fresh* sync (high-water mark = 0): bounds the first pull/push so it
 * can't dump an enormous backlog. Incremental syncs are naturally small (delta).
 */
export const FRESH_SYNC_LIMIT = 50;

/** Live agent sessions for a destination thread key (null = the room's main
 * session). Existing sessions only — a thread with no session yet has no agent
 * memory to seed; the copied transcript is still visible in chat and the agent
 * picks it up when its session is first created through the normal inbound path. */
export async function sessionsForThreadKey(
  messagingGroupId: string,
  sessionKey: string | null,
): Promise<TeardownTarget[]> {
  const rows = (
    sessionKey === null
      ? await getDb().all(
          `SELECT id, agent_group_id FROM sessions WHERE messaging_group_id = ? AND thread_id IS NULL`,
          messagingGroupId,
        )
      : await getDb().all(
          `SELECT id, agent_group_id FROM sessions WHERE messaging_group_id = ? AND thread_id = ?`,
          messagingGroupId,
          sessionKey,
        )
  ) as { id: string; agent_group_id: string }[];
  return rows.map((r) => ({ sessionId: r.id, agentGroupId: r.agent_group_id }));
}

/**
 * Copy the native message delta from one thread into another (verbatim, additive),
 * seed the destination thread's agent session(s) with it as silent context
 * (trigger=0 — never wakes a turn), broadcast the copies to connected clients, and
 * advance the per-thread high-water mark so repeat syncs only carry genuinely new
 * messages. `markThreadId` is always the topic thread the (main, topic) pair is
 * keyed under — both directions track progress against that one row so a push and
 * a pull on the same thread don't share a mark. Returns the number of messages
 * copied (excluding the divider; 0 = nothing new). See
 * docs/webchat/thread-context-sync.md.
 */
export async function syncThreadContext(opts: {
  roomId: string;
  srcThreadId: string;
  destThreadId: string;
  markThreadId: string;
  direction: 'pulled' | 'pushed';
  dividerText: string;
  freshLimit?: number;
}): Promise<number> {
  const { roomId, srcThreadId, destThreadId, markThreadId, direction, dividerText, freshLimit = 0 } = opts;
  const marks = await getThreadSyncMarks(roomId, markThreadId);
  const sinceTs = direction === 'pulled' ? marks.pulled : marks.pushed;
  const delta = await getSyncDelta(roomId, srcThreadId, sinceTs, sinceTs === 0 ? freshLimit : 0);
  if (delta.length === 0) return 0;

  const inserted = await insertSyncedMessages(roomId, destThreadId, delta, direction, dividerText);

  // Advance the high-water mark to the newest source row carried, so a repeat
  // sync only picks up messages added after this batch (setThreadSyncMark is
  // monotonic, so a concurrent larger mark never moves backwards).
  const maxSrcTs = delta.reduce((mx, m) => Math.max(mx, m.created_at), sinceTs);
  await setThreadSyncMark(roomId, markThreadId, direction, maxSrcTs);

  // Broadcast the copies (divider + messages) so the destination thread updates live.
  for (const row of inserted) {
    await broadcast(roomId, { type: 'message', ...row });
  }

  // Seed the destination thread's agent session(s) with the copied transcript as
  // silent context. Content matches the webchat inbound shape so the agent-runner
  // formats it identically to a real message.
  const copies = inserted.filter((m) => m.message_type !== 'context-divider');
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (mg) {
    const destKey = threadToSessionKey(destThreadId);
    for (const s of await sessionsForThreadKey(mg.id, destKey)) {
      const ctx: ContextMessage[] = copies.map((m) => ({
        id: `ctx-${direction}-${s.sessionId}-${m.id}`,
        kind: 'chat',
        timestamp: new Date(m.created_at).toISOString(),
        platformId: roomId,
        channelType: 'webchat',
        threadId: destKey,
        content: JSON.stringify({ text: m.content, sender: m.sender, senderName: m.sender, senderId: '' }),
        trigger: 0,
      }));
      syncSessionContext(s.agentGroupId, s.sessionId, ctx);
    }
  }
  return copies.length;
}

export async function importRoomUploadHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  sweepPendingImports();
  let tmpFile: string | null = null;
  try {
    tmpFile = await spoolUploadToTmp(req);
    const listing = await new Promise<string>((resolve, reject) => {
      const p = spawnTar(['-tzf', tmpFile!]);
      let out = '';
      let err = '';
      p.stdout?.on('data', (d: Buffer) => (out += d));
      p.stderr?.on('data', (d: Buffer) => (err += d));
      p.on('close', (code: number) =>
        code === 0 ? resolve(out) : reject(new Error(`tar -t failed: ${err.slice(0, 200)}`)),
      );
    });
    const bad = listing
      .split('\n')
      .filter(Boolean)
      .filter((e) => !isSafeRoomEntry(e));
    if (bad.length > 0) throw new Error(`Bundle contains unsafe paths: ${bad.slice(0, 3).join(', ')}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-roomimport-'));
    await new Promise<void>((resolve, reject) => {
      const p = spawnTar(['-xzf', tmpFile!, '-C', dir, '--no-same-owner']);
      let err = '';
      p.stderr?.on('data', (d: Buffer) => (err += d));
      p.on('close', (code: number) =>
        code === 0 ? resolve() : reject(new Error(`tar -x failed: ${err.slice(0, 200)}`)),
      );
    });
    const preview = await previewRoomImport(dir);
    const token = randomUUID();
    pendingAgentImports.set(token, { dir, at: Date.now() });
    return json(res, 200, { token, preview });
  } catch (err) {
    return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (tmpFile) fs.rmSync(tmpFile, { force: true });
  }
}

export async function importRoomApplyHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { token?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  const staged = pendingAgentImports.get(String(body.token || ''));
  if (!staged) return json(res, 410, { error: 'Import expired — upload the bundle again' });
  try {
    const result = await applyRoomImport(staged.dir);
    pendingAgentImports.delete(String(body.token));
    fs.rmSync(staged.dir, { recursive: true, force: true });
    await broadcastRooms();
    return json(res, 200, { ok: true, ...(await result) });
  } catch (err) {
    log.error('Room import apply failed', { err });
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Refs to agents in the room create / add-agent endpoints. Either an existing
 * agent (by id) or a new agent created inline.
 */
export type AgentRef =
  | { kind: 'existing'; id: string }
  | { kind: 'new'; name: string; instructions?: string; provider?: string };

export function parseAgentRef(raw: unknown): AgentRef | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid agent reference' };
  const r = raw as { kind?: unknown; id?: unknown; name?: unknown; instructions?: unknown; provider?: unknown };
  if (r.kind === 'existing') {
    if (typeof r.id !== 'string' || !r.id.trim()) return { error: 'agent.id required for kind=existing' };
    return { kind: 'existing', id: r.id.trim() };
  }
  if (r.kind === 'new') {
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'agent.name required for kind=new' };
    // Optional non-default provider for the new agent (wizard "default engine"
    // = Codex). Only 'codex' is accepted — 'claude' is the implicit default.
    if (r.provider !== undefined) {
      const allowed = availableProviders();
      if (typeof r.provider !== 'string' || !allowed.includes(r.provider))
        return {
          error: allowed.length
            ? `agent.provider must be one of: ${allowed.join(', ')}`
            : 'agent.provider is not settable — no non-default harness is installed',
        };
    }
    return {
      kind: 'new',
      name: r.name.trim(),
      instructions: typeof r.instructions === 'string' ? r.instructions : undefined,
      provider: r.provider as string | undefined,
    };
  }
  return { error: 'agent.kind must be "existing" or "new"' };
}

export async function createRoomHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let body: { name?: unknown; agents?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if (typeof body.name !== 'string' || !body.name.trim()) return json(res, 400, { error: 'name required' });
  const roomName = body.name.trim();
  if (!Array.isArray(body.agents) || body.agents.length === 0) {
    return json(res, 400, { error: 'At least one agent required (rooms cannot be empty)' });
  }

  // Validate everything up-front so we don't half-create.
  const refs: AgentRef[] = [];
  for (const ref of body.agents) {
    const p = parseAgentRef(ref);
    if ('error' in p) return json(res, 400, { error: p.error });
    if (p.kind === 'existing' && !(await getAgentGroup(p.id))) {
      return json(res, 404, { error: `Agent ${p.id} not found` });
    }
    refs.push(p);
  }

  const roomId = nameToFolder(roomName);
  if (!roomId) return json(res, 400, { error: 'Could not derive room id from name' });
  if (await getMessagingGroupByPlatform('webchat', roomId)) {
    return json(res, 409, { error: 'Room with this name already exists' });
  }

  // Create any "new" agents first (they live outside the DB transaction
  // because initGroupFilesystem touches disk). Track them so we can roll
  // back if the wiring step fails.
  const createdAgentIds: string[] = [];
  const wireIds: string[] = [];
  for (const ref of refs) {
    if (ref.kind === 'existing') {
      wireIds.push(ref.id);
      continue;
    }
    const result = createBareAgentGroup(ref.name, { instructions: ref.instructions });
    if ('error' in result) {
      await rollbackBareAgents(createdAgentIds);
      return json(res, result.status, { error: result.error });
    }
    createdAgentIds.push(result.group.id);
    wireIds.push(result.group.id);
    // Non-default provider (validated in parseAgentRef): pin it on the group's
    // container config so the first spawn already runs the right harness.
    if (ref.provider) {
      await ensureContainerConfig(result.group.id);
      await updateContainerConfigScalars(result.group.id, { provider: ref.provider });
    }
  }

  try {
    await getDb().transaction(async () => {
      await createWebchatRoom(roomName, roomId);
      for (const id of wireIds) await wireAgentToWebchatRoom(roomName, roomId, id);
      // Default engage mode is mention-only: agents fire on explicit @-mention.
      // EXCEPTION: a room created with exactly one agent auto-primes that agent
      // (it then replies to everything) — consistent with the empty-room →
      // first-agent path below, and avoiding the "you must @-mention the only
      // agent to get a reply" surprise. Multi-agent rooms stay mention-only
      // until the operator picks a default. Inside the transaction so a partial
      // failure can't leave a settings/prime row referencing a half-created room.
      await setRoomEngageDefault(roomId, 'mention-only');
      if (wireIds.length === 1) await setPrimeAgentForWebchatRoom(roomId, wireIds[0]);
    });
    // recomputeEngagePatterns reads the current wirings + prime + engage_default,
    // so it runs AFTER the transaction commits: a single-agent room now has a
    // prime (→ that agent answers everything); a multi-agent room has none
    // (→ every wiring gets `\B@<folder>\b`).
    await recomputeEngagePatterns(roomId);
  } catch (err) {
    await rollbackBareAgents(createdAgentIds);
    log.warn('Webchat: createRoom failed', { roomName, err });
    return json(res, 500, { error: 'Could not create room' });
  }

  await broadcastRooms();
  return json(res, 200, {
    ok: true,
    room: await getWebchatRoom(roomId),
    agents: await getAgentsForWebchatRoom(roomId),
  });
}

export async function rollbackBareAgents(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      const g = await getAgentGroup(id);
      await deleteAgentGroup(id);
      if (g) {
        const dir = path.resolve(GROUPS_DIR, g.folder);
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort — log? these are inner-loop rollbacks
    }
  }
}

export async function deleteRoomHandler(res: ServerResponse, roomId: string): Promise<void> {
  const room = getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });

  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  // Snapshot sessions before the transaction so we can clean up containers
  // and dirs after it commits (side-effects can't roll back).
  const sessions: TeardownTarget[] = mg ? await findSessionsByMessagingGroup(mg.id) : [];

  try {
    await getDb().transaction(async () => {
      for (const s of sessions) await deleteSessionDbState(s.sessionId);
      // deleteWebchatRoom drops messages, wirings, and the messaging_group row.
      // Agents are deliberately preserved — they may be wired to other rooms,
      // and DELETE /api/agents/:id is the cascade-to-agent path.
      await deleteWebchatRoom(roomId);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Webchat: deleteRoomHandler failed', { roomId, err });
    return json(res, 500, { error: 'Failed to delete room', message });
  }

  // Fire-and-forget: the DB tx committed, so we can respond immediately.
  // Container kills + dir cleanup are best-effort post-commit hygiene that
  // the user doesn't need to wait on. Errors are logged inside the helper.
  void teardownSessionResources(sessions, `webchat room ${roomId} deleted`);

  // Remove the room's upload dir. The messaging_group is gone, so the files
  // are unreachable from the API — leaving them is just dead disk space.
  const uploadsDir = path.resolve(DATA_DIR, 'webchat', 'uploads', roomId);
  try {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Webchat: failed to remove room uploads dir', { roomId, err });
  }

  await broadcastRooms();
  return json(res, 200, { ok: true });
}

/** Delete a thread: drop its registry row + messages + read markers, and tear
 * down its per-thread session (DB state in the txn; container/dir after commit).
 * The room and other threads are untouched. */
export async function deleteThreadHandler(res: ServerResponse, roomId: string, threadId: string): Promise<void> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  // The session for a named thread is keyed by thread_id = threadId.
  const sessions: TeardownTarget[] = mg ? await findSessionsByMessagingGroupThread(mg.id, threadId) : [];
  try {
    await getDb().transaction(async () => {
      for (const s of sessions) await deleteSessionDbState(s.sessionId);
      await deleteWebchatThread(roomId, threadId);
    });
  } catch (err) {
    log.error('Webchat: deleteThreadHandler failed', { roomId, threadId, err });
    return json(res, 500, { error: 'Failed to delete thread' });
  }
  // Side-effects after commit (can't roll back): kill containers + remove dirs.
  void teardownSessionResources(sessions, 'webchat thread deleted');
  await broadcastRooms(); // refresh each client's sidebar thread-count chevron
  return json(res, 200, { ok: true });
}

export async function addAgentToRoomHandler(
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  userId: string,
): Promise<void> {
  const room = await getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });
  const raw = await readJsonBody(req, res);
  if (raw === null) return;
  let parsed: AgentRef | { error: string };
  try {
    parsed = parseAgentRef(JSON.parse(raw));
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }
  if ('error' in parsed) return json(res, 400, { error: parsed.error });

  let agentId: string;
  let createdAgentId: string | null = null;
  if (parsed.kind === 'existing') {
    if (!(await getAgentGroup(parsed.id))) return json(res, 404, { error: `Agent ${parsed.id} not found` });
    // Owner can wire any agent. A scoped admin may wire an agent THEY
    // administer to a room they can access (the same access set the picker
    // is filtered to).
    if (!(await isOwner(userId)) && !((await canAccessRoom(userId, roomId)) && (await hasAdminPrivilege(userId, parsed.id)))) {
      return json(res, 403, { error: 'Admin privilege required' });
    }
    agentId = parsed.id;
  } else {
    // Creating a brand-new agent via this path stays owner-only: unlike
    // createAgentHandler, this branch does not grant the creator admin on the
    // new group, so a scoped admin would end up unable to manage what they
    // just made. Scoped admins assign EXISTING agents (the branch above).
    if (!(await isOwner(userId))) {
      return json(res, 403, { error: 'Owner only' });
    }
    const result = createBareAgentGroup(parsed.name, { instructions: parsed.instructions });
    if ('error' in result) return json(res, result.status, { error: result.error });
    agentId = result.group.id;
    createdAgentId = result.group.id;
  }

  // Snapshot the count BEFORE wiring so we can decide whether the new
  // agent should auto-become prime. Rule: a room transitioning from
  // 0 → 1 wired agents (e.g. an empty room being seeded, or an agent
  // re-added after the prior one was unwired) auto-primes the newcomer.
  // Rooms going from 1+ → 2+ leave the existing prime alone — operator
  // picks via the ★ toggle if they want to swap.
  const wasEmpty = (await countAgentsForWebchatRoom(roomId)) === 0;

  try {
    await wireAgentToWebchatRoom(room.name, roomId, agentId);
    if (wasEmpty) {
      await setPrimeAgentForWebchatRoom(roomId, agentId);
      await recomputeEngagePatterns(roomId);
    }
  } catch (err) {
    if (createdAgentId) await rollbackBareAgents([createdAgentId]);
    log.warn('Webchat: addAgentToRoom failed', { roomId, agentId, err });
    return json(res, 500, { error: 'Could not wire agent to room' });
  }

  await broadcastRooms();
  const wired: WebchatRoomAgent | undefined = (await getAgentsForWebchatRoom(roomId)).find((a) => a.id === agentId);
  return json(res, 200, { ok: true, agent: wired });
}

export async function removeAgentFromRoomHandler(res: ServerResponse, roomId: string, agentId: string): Promise<void> {
  const room = await getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });
  if ((await countAgentsForWebchatRoom(roomId)) <= 1) {
    return json(res, 400, {
      error: 'Cannot remove the last agent from a room. Delete the room with DELETE /api/rooms/:id instead.',
    });
  }
  const removed = unwireAgentFromWebchatRoom(roomId, agentId);
  if (!removed) return json(res, 404, { error: 'Agent is not wired to this room' });
  // If we just unwired the prime, clear the designation. Recompute either
  // way so remaining wirings get a fresh pattern set (the prime's
  // negative-lookahead may need to lose this agent's folder, or the
  // patterns may need to revert to '.').
  if ((await getPrimeAgentForWebchatRoom(roomId)) === agentId) {
    await clearPrimeAgentForWebchatRoom(roomId);
  }
  await recomputeEngagePatterns(roomId);
  await broadcastRooms();
  return json(res, 200, { ok: true });
}

export async function setRoomPrimeHandler(res: ServerResponse, roomId: string, agentId: string): Promise<void> {
  const room = getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });
  // Verify the candidate is actually wired to this room — otherwise the
  // recompute would treat the prime as stale and silently fall back.
  const wired = (await getAgentsForWebchatRoom(roomId)).some((a) => a.id === agentId);
  if (!wired) return json(res, 400, { error: 'Agent is not wired to this room' });
  await setPrimeAgentForWebchatRoom(roomId, agentId);
  await recomputeEngagePatterns(roomId);
  await broadcastRooms();
  return json(res, 200, { ok: true, primeAgentId: agentId });
}

export function clearRoomPrimeHandler(res: ServerResponse, roomId: string): void {
  const room = getWebchatRoom(roomId);
  if (!room) return json(res, 404, { error: 'Room not found' });
  clearPrimeAgentForWebchatRoom(roomId);
  recomputeEngagePatterns(roomId);
  broadcastRooms();
  return json(res, 200, { ok: true });
}
