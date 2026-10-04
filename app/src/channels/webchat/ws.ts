/**
 * Webchat WebSocket protocol.
 *
 * The HTTP upgrade on /ws is gated by authenticateRequest(); the client then
 * sends `{type:'auth'}` to bind the connection to its userId. Inbound messages
 * go to the `onInbound` hook with `senderId` in content for the permissions
 * senderResolver. Agents never write back through this socket (outbound.db).
 */
import http from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import type { InboundMessage } from '../adapter.js';
import {
  WSClient,
  clients,
  addClient,
  removeClient,
  broadcast,
  getMemberList,
  annotateRoomsForUser,
  markRoomReadForUser,
  getActiveTurns,
} from './state.js';
import {
  deleteWebchatMessage,
  ensureWebchatUserHandle,
  getWebchatMessages,
  getWebchatRoom,
  storeWebchatMessage,
  MAIN_THREAD,
  threadToSessionKey,
  markThreadRead,
  resolveBoundedThread,
} from './db.js';
import { hostAllowed, originAllowed } from './request-guard.js';
import { canAccessRoom } from './access.js';
import { redactSensitiveData } from './redact.js';
import { withTraceFlags } from './turn-traces.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getRunningSessions } from '../../db/sessions.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { writeSessionMessage } from '../../session-manager.js';
import { filterAsync } from './async-array.js';

/**
 * The Stop button (the CLI's ESC): a trigger=0 `interrupt` row into each running
 * session's inbound.db, which the poll loop honours mid-turn and ignores
 * otherwise. Never wakes a container. `agentName` narrows it to one agent.
 */
async function interruptRoomSessions(roomId: string, agentName?: string | null): Promise<void> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return;
  let sessions = (await getRunningSessions()).filter((s) => s.messaging_group_id === mg.id);
  if (agentName) {
    sessions = await filterAsync(sessions, async (s) => (await getAgentGroup(s.agent_group_id))?.name === agentName);
  }
  for (const s of sessions) {
    await writeSessionMessage(s.agent_group_id, s.id, {
      id: `interrupt-${randomUUID()}`,
      kind: 'interrupt',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ reason: 'user-stop' }),
      trigger: false, // control signal only — must not wake/spawn a container
    });
  }
}

// Cap inbound WS messages — chat payloads are small (text, controls);
// without this, ws's default (100 MB) lets an authenticated client OOM the
// host with one giant JSON.
const WS_MAX_PAYLOAD = 1024 * 1024; // 1 MB
const WS_PING_INTERVAL = 30_000;

// Carries identity from the HTTP upgrade into the WS connection event.
interface AuthedUpgradeRequest extends http.IncomingMessage {
  _authUserId?: string;
  _authDisplayName?: string;
}

export interface WSHooks {
  /** Inbound chat from a connected client → router. `threadId` is the session
   * key (null = the room's main/default thread). */
  onInbound: (roomId: string, message: InboundMessage, threadId: string | null) => void;
}

export interface AuthForUpgrade {
  userId: string;
  displayName: string;
}

// Inbound idempotency: a client_id repeated within this window (resend,
// double-fire) is dropped so it can't spawn a second agent turn. Ids are unique
// per send (`local-<seq>-<ts>`), so global keying never collides.
const CLIENT_ID_DEDUP_WINDOW_MS = 10_000;
const seenClientIds = new Map<string, number>();

/**
 * Atomically claim a client_id: returns true if it is fresh (proceed) and records
 * it; returns false if it was already seen within the window (drop the duplicate).
 * Opportunistically prunes expired ids to bound memory. Exported for tests.
 */
export function claimClientId(id: string, now: number = Date.now()): boolean {
  const prev = seenClientIds.get(id);
  if (prev !== undefined && now - prev < CLIENT_ID_DEDUP_WINDOW_MS) return false;
  seenClientIds.set(id, now);
  if (seenClientIds.size > 1000) {
    for (const [k, t] of seenClientIds) if (now - t >= CLIENT_ID_DEDUP_WINDOW_MS) seenClientIds.delete(k);
  }
  return true;
}

/** Give back a claim whose send never landed, so the client's retry is not dropped. */
export function releaseClientId(id: string): void {
  seenClientIds.delete(id);
}

// ── Upgrade-path registry ─────────────────────────────────────────────────
// The HTTP server has exactly ONE 'upgrade' listener: the one below. Another
// WebSocket endpoint must register its path here rather than add a listener of
// its own — a listener that does not recognise a path destroys the socket, so
// two listeners on one server can never coexist safely.
export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
const upgradeHandlers = new Map<string, UpgradeHandler>();

export function registerUpgradeHandler(pathname: string, handler: UpgradeHandler): void {
  if (upgradeHandlers.has(pathname)) throw new Error(`Upgrade handler already registered for ${pathname}`);
  upgradeHandlers.set(pathname, handler);
}
export function __resetUpgradeHandlersForTest(): void {
  upgradeHandlers.clear();
}

// Keyed by the requested path, which a scanner picks: capped, oldest dropped first.
const REFUSALS_NOTED_MAX = 256;
const refusalsNoted = new Map<string, number>();
function noteRefusedUpgrade(req: http.IncomingMessage, check: 'origin' | 'host'): void {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const key = `${check} ${path}`;
  const now = Date.now();
  if ((refusalsNoted.get(key) ?? 0) > now - 60_000) return;
  refusalsNoted.delete(key);
  refusalsNoted.set(key, now);
  if (refusalsNoted.size > REFUSALS_NOTED_MAX) refusalsNoted.delete(refusalsNoted.keys().next().value!);
  logPreAuth('WebSocket upgrade refused', {
    check,
    path: clipHeader(path),
    host: clipHeader(String(req.headers.host ?? '')),
    origin: clipHeader(String(req.headers.origin ?? '')),
    remoteIp: (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''),
  });
}

/** A caller-chosen value as it goes into a log line: no control characters, at most 100 of the rest. */
export function clipHeader(value: string): string {
  return value.replace(/\p{Cc}/gu, '').slice(0, 100);
}

// Lines logged before a caller is authenticated: whoever connects picks how
// many, so all of them share one budget a minute, and the rest are counted.
const PREAUTH_LOGS_PER_MINUTE = 30;
let preAuthWindowStart = 0;
let preAuthLogged = 0;
let preAuthSuppressed = 0;
let preAuthFlush: NodeJS.Timeout | null = null;
function flushPreAuthSuppressed(): void {
  if (preAuthFlush) clearTimeout(preAuthFlush);
  preAuthFlush = null;
  if (preAuthSuppressed > 0) log.warn('Pre-auth log lines suppressed', { suppressed: preAuthSuppressed });
  preAuthSuppressed = 0;
}
export function logPreAuth(msg: string, fields: Record<string, unknown>, now: number = Date.now()): void {
  if (now - preAuthWindowStart >= 60_000) {
    flushPreAuthSuppressed();
    preAuthWindowStart = now;
    preAuthLogged = 0;
  }
  if (preAuthLogged < PREAUTH_LOGS_PER_MINUTE) {
    preAuthLogged++;
    log.warn(msg, fields);
    return;
  }
  preAuthSuppressed++;
  if (!preAuthFlush) {
    preAuthFlush = setTimeout(flushPreAuthSuppressed, Math.max(0, preAuthWindowStart + 60_000 - now));
    preAuthFlush.unref();
  }
}
export function __resetPreAuthLogForTest(): void {
  if (preAuthFlush) clearTimeout(preAuthFlush);
  preAuthFlush = null;
  preAuthWindowStart = 0;
  preAuthLogged = 0;
  preAuthSuppressed = 0;
}

export function setupWebSocket(
  server: http.Server,
  hooks: WSHooks,
  authenticate: (req: http.IncomingMessage) => Promise<AuthForUpgrade | null>,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  // Ping/pong keepalive — terminate clients that don't pong within the window.
  const pingTimer = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.isAlive) {
        c.ws.terminate();
        removeClient(c.id);
        continue;
      }
      c.isAlive = false;
      c.ws.ping();
    }
  }, WS_PING_INTERVAL);
  wss.on('close', () => clearInterval(pingTimer));

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      // Every WebSocket path: a cross-site page must not open one with the
      // visitor's ambient identity, nor reach us under a rebound host name.
      const originOk = originAllowed(req);
      if (!originOk || !(await hostAllowed(req))) {
        // Said once per path and reason a minute: a bare 403 on the upgrade is
        // otherwise indistinguishable, from the client, from a proxy's.
        noteRefusedUpgrade(req, originOk ? 'host' : 'origin');
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        const other = upgradeHandlers.get(url.pathname);
        if (other) other(req, socket, head);
        else socket.destroy();
        return;
      }

      const auth = await authenticate(req);
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const augmented = req as AuthedUpgradeRequest;
        augmented._authUserId = auth.userId;
        augmented._authDisplayName = auth.displayName;
        wss.emit('connection', ws, req);
      });
    })().catch((err) => {
      log.warn('Webchat WS upgrade failed', { err });
      socket.destroy();
    });
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const augmented = req as AuthedUpgradeRequest;
    const clientId = randomUUID();
    const userId = augmented._authUserId ?? 'webchat:unknown';
    const displayName = augmented._authDisplayName ?? userId;
    // Make this user @-mentionable right away: ensure a handle exists (defaults
    // to a slug of the display name, suffixed on collision). Idempotent.
    try {
      ensureWebchatUserHandle(userId, displayName).catch((err) =>
        log.warn('ensureWebchatUserHandle failed', { userId, err: err instanceof Error ? err.message : err }),
      );
    } catch (err) {
      log.warn('ensureWebchatUserHandle failed', { userId, err: err instanceof Error ? err.message : err });
    }

    const client: WSClient = {
      id: clientId,
      ws,
      identity: displayName,
      identity_type: 'user',
      userId,
      isAlive: true,
    };
    addClient(client);

    ws.on('pong', () => {
      client.isAlive = true;
    });
    ws.on('error', (err) => {
      log.warn('Webchat WS client error', { clientId, identity: client.identity, err: err.message });
    });

    let authenticated = false;
    const send = (data: object): void => {
      try {
        ws.send(JSON.stringify(data));
      } catch {
        // Socket may have closed between send-side check and write — swallow.
      }
    };

    // Frames must process IN ARRIVAL ORDER: an async listener interleaves at every
    // await, so a `message` right after `join` would see no room yet. Chain them.
    let frameChain: Promise<void> = Promise.resolve();
    const handleFrame = async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        send({ type: 'error', error: 'Invalid JSON' });
        return;
      }

      // ── AUTH ────────────────────────────────────────────────────────────
      if (msg.type === 'auth') {
        // v2: agent-token auth dropped. The upgrade-time identity is the only
        // identity. The auth message just confirms the session is established.
        authenticated = true;
        send({ type: 'system', message: `Connected as ${client.identity}` });
        // Annotated payload (incl. per-user `unread`) so the sidebar reconstructs
        // unread badges on reconnect — not just for messages seen live.
        send({ type: 'rooms', rooms: await annotateRoomsForUser(client.userId) });
        return;
      }

      if (!authenticated) {
        send({ type: 'error', error: 'Not authenticated' });
        return;
      }

      // ── JOIN ─────────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        const roomId = typeof msg.room_id === 'string' ? msg.room_id : '';
        const room = await getWebchatRoom(roomId);
        // Logged: a refused join leaves the client tracking its previous room, so
        // its messages store fine but never render until it switches rooms.
        if (!room) {
          log.warn('Webchat: join refused — room not found', { roomId, userId: client.userId });
          send({ type: 'error', error: `Room not found: ${roomId}` });
          return;
        }
        if (!(await canAccessRoom(client.userId, room.id))) {
          log.warn('Webchat: join refused — access denied', { roomId: room.id, userId: client.userId });
          send({ type: 'error', error: 'Access denied' });
          return;
        }
        client.room_id = room.id;
        // Thread being opened (default 'main'). History is filtered to it; live
        // messages still arrive room-wide and the client routes them by thread.
        const joinThread = typeof msg.thread_id === 'string' && msg.thread_id ? msg.thread_id : MAIN_THREAD;
        client.thread_id = joinThread;
        // Opening reads it: advance the room marker (clears the room dot + syncs
        // devices) and the per-thread marker.
        markRoomReadForUser(client.userId, room.id, Date.now(), clientId);
        await markThreadRead(client.userId, room.id, joinThread);
        send({
          type: 'history',
          room_id: room.id,
          thread_id: joinThread,
          messages: (await withTraceFlags(await getWebchatMessages(room.id, 50, joinThread))).map((m) => ({
            ...m,
            content: redactSensitiveData(m.content),
          })),
        });
        await broadcast(room.id, { type: 'system', room_id: room.id, message: `${client.identity} joined` }, clientId);
        await broadcast(room.id, {
          type: 'members',
          room_id: room.id,
          members: await getMemberList(room.id),
        });
        // Replay in-progress turns as a synthetic `start`; live frames refine it.
        for (const agentName of getActiveTurns(room.id)) {
          send({ type: 'status', room_id: room.id, agent_name: agentName || null, event: 'start' });
        }
        return;
      }

      // ── TYPING ───────────────────────────────────────────────────────────
      if (msg.type === 'typing') {
        if (!client.room_id) return;
        await broadcast(
          client.room_id,
          {
            type: 'typing',
            room_id: client.room_id,
            identity: client.identity,
            identity_type: client.identity_type,
            is_typing: !!msg.is_typing,
          },
          clientId,
        );
        return;
      }

      // ── READ ─────────────────────────────────────────────────────────────
      // Client signals it has caught up on a room (e.g. a message arrived while
      // the room was open and focused). Advances the server marker and clears
      // the badge on the user's other devices. Scoped to rooms the user can see.
      if (msg.type === 'read') {
        const roomId = typeof msg.room_id === 'string' ? msg.room_id : '';
        if (!roomId) return;
        const room = await getWebchatRoom(roomId);
        if (!room || !(await canAccessRoom(client.userId, room.id))) return;
        markRoomReadForUser(client.userId, room.id, Date.now(), clientId);
        // Per-thread marker (default 'main') so thread badges clear too.
        const readThread = typeof msg.thread_id === 'string' && msg.thread_id ? msg.thread_id : MAIN_THREAD;
        await markThreadRead(client.userId, room.id, readThread);
        return;
      }

      // ── MESSAGE ──────────────────────────────────────────────────────────
      if (msg.type === 'message') {
        if (!client.room_id) {
          send({ type: 'error', error: 'Join a room first' });
          return;
        }
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (!text.trim()) return;

        // A duplicate client_id is dropped silently (see CLIENT_ID_DEDUP_WINDOW_MS);
        // the first delivery already echoed the sender's bubble.
        const cid = typeof msg.client_id === 'string' ? msg.client_id : null;
        if (cid && !claimClientId(cid)) {
          log.warn('Webchat: dropped duplicate message (client_id already seen)', {
            clientId: cid,
            identity: client.identity,
          });
          return;
        }

        // BOUNDED thread resolution: a client-supplied thread_id must not spawn
        // unbounded sessions (resolveBoundedThread, shared with file uploads).
        let storeThread: string;
        let stored: Awaited<ReturnType<typeof storeWebchatMessage>>;
        try {
          storeThread = await resolveBoundedThread(client.room_id, msg.thread_id);
          stored = await storeWebchatMessage(client.room_id, client.identity, client.identity_type, text, storeThread);
        } catch (err) {
          // Nothing was stored: release the claim so a resend of this client_id
          // goes through, and tell the sender, whose bubble would otherwise sit
          // on its single tick.
          if (cid) releaseClientId(cid);
          log.warn('Webchat: storing a message failed', {
            identity: client.identity,
            err: err instanceof Error ? err.message : String(err),
          });
          send({ type: 'error', error: 'Message not sent', client_id: cid });
          return;
        }
        // The sender has by definition read their own message — advance their
        // marker (and sync their other devices) so it never self-unreads.
        markRoomReadForUser(client.userId, client.room_id, stored.created_at, clientId);
        const outgoing: Record<string, unknown> = { type: 'message', ...stored };
        if (typeof msg.client_id === 'string') outgoing.client_id = msg.client_id;
        await broadcast(client.room_id, outgoing, clientId);

        // threadId is the SESSION key (null for main).
        hooks.onInbound(
          client.room_id,
          {
            id: stored.id,
            kind: 'chat',
            timestamp: new Date(stored.created_at).toISOString(),
            isGroup: true,
            content: {
              text,
              sender: client.identity,
              senderId: client.userId,
              senderName: client.identity,
            },
          },
          threadToSessionKey(storeThread),
        );

        send({ ...outgoing, content: redactSensitiveData(stored.content) });
        return;
      }

      // ── INTERRUPT (GUI "stop", the ESC equivalent) ───────────────────────
      if (msg.type === 'interrupt') {
        if (!client.room_id) return;
        const agentName = typeof msg.agent_name === 'string' ? msg.agent_name : undefined;
        await interruptRoomSessions(client.room_id, agentName);
        return;
      }

      // ── DELETE MESSAGE ───────────────────────────────────────────────────
      if (msg.type === 'delete_message') {
        if (!client.room_id) return;
        const messageId = typeof msg.message_id === 'string' ? msg.message_id : '';
        if (!messageId) {
          send({ type: 'error', error: 'message_id required' });
          return;
        }
        const deleted = await deleteWebchatMessage(messageId, client.identity, client.room_id);
        if (await deleted) {
          await broadcast(client.room_id, {
            type: 'delete_message',
            room_id: client.room_id,
            message_id: messageId,
          });
        }
        return;
      }
    };
    ws.on('message', (raw) => {
      frameChain = frameChain
        .then(() => handleFrame(raw))
        .catch((err) => {
          // Keep the chain alive and ordered, but never silently: a dropped
          // frame is a lost message from the user's point of view.
          log.warn('Webchat: WS frame handler failed', { err: err instanceof Error ? err.message : String(err) });
        });
    });

    ws.on('close', () => {
      const c = removeClient(clientId);
      if (c?.room_id) {
        const roomId = c.room_id; // capture: the narrowing doesn't survive into the .then closure
        void broadcast(roomId, {
          type: 'system',
          room_id: roomId,
          message: `${c.identity} left`,
        }).catch((err) => log.warn('Webchat: left-broadcast failed', { err: String(err) }));
        // The close handler is a sync event callback; resolve the member list
        // first, THEN broadcast — embedding the promise serialized as {}.
        void getMemberList(roomId)
          .then((members) => broadcast(roomId, { type: 'members', room_id: roomId, members }))
          .catch((err) => log.warn('Webchat: members-broadcast failed', { err: String(err) }));
      }
    });
  });

  return wss;
}
