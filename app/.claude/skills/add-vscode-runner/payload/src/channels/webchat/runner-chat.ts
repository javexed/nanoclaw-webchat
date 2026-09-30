/**
 * The chat view inside VS Code.
 *
 * A developer talks to their machine's dedicated agent from the editor. There
 * is no second auth surface: the frames ride the runner's own authenticated
 * socket, and central attributes them to the user that socket belongs to.
 * Only that user's own dedicated room is reachable here — the room of the
 * group placed on this machine — and only if the user may access it. A
 * message sent from the editor takes exactly the path a PWA message takes:
 * store, mark read, broadcast, route to the agent.
 *
 * Frames (runner → central): `chat.open {}`, `chat.send { text }`.
 * Frames (central → runner): `chat.room { roomId, name, messages }`,
 * `chat.message { …WebchatMessage }`, `chat.status { event, text, detail,
 * agentName }` (the agent's activity: the PWA's thinking bubble), and
 * `chat.error { message }`.
 */
import type { InboundMessage } from '../adapter.js';
import { log } from '../../log.js';

import { canAccessRoom } from './access.js';
import {
  getWebchatMessages,
  getWebchatRoomsForAgent,
  storeWebchatMessage,
  threadToSessionKey,
  type WebchatMessage,
} from './db.js';
import { redactSensitiveData } from './redact.js';
import { listPlacements } from './runner-registry.js';
import { sendRunnerFrame } from './runner-transport.js';
import { broadcast, getActiveTurns, markRoomReadForUser, onRoomMessage, onRoomStatus } from './state.js';

export interface ChatDeps {
  roomForMachine: (fingerprint: string) => Promise<{ id: string; name: string } | null>;
  canAccess: (userId: string, roomId: string) => Promise<boolean>;
  history: (roomId: string, limit: number) => Promise<WebchatMessage[]>;
  store: (roomId: string, sender: string, senderType: string, text: string) => Promise<WebchatMessage>;
  markRead: (userId: string, roomId: string, ts: number) => void;
  broadcast: (roomId: string, msg: Record<string, unknown>) => Promise<void>;
  inbound: ((roomId: string, message: InboundMessage, threadId: string | null) => void) | null;
  send: (fingerprint: string, frame: Record<string, unknown>) => boolean;
  redact: (s: string) => string;
  /** Agents with a turn in progress in a room — replayed to a view that opens mid-turn. */
  activeTurns: (roomId: string) => string[];
}

const MAX_TEXT = 32_000;
const HISTORY = 100;

let deps: ChatDeps = defaultDeps();
/** fingerprint → room it has opened */
const openRooms = new Map<string, string>();
let unsubscribe: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;

export function defaultDeps(): ChatDeps {
  return {
    async roomForMachine(fingerprint) {
      const placement = (await listPlacements()).find((p) => p.fingerprint === fingerprint);
      if (!placement) return null;
      const rooms = await getWebchatRoomsForAgent(placement.agent_group_id);
      const room = rooms.find((r) => r.is_prime) ?? rooms[0];
      return room ? { id: room.id, name: room.name } : null;
    },
    canAccess: canAccessRoom,
    history: (roomId, limit) => getWebchatMessages(roomId, limit),
    store: (roomId, sender, senderType, text) => storeWebchatMessage(roomId, sender, senderType, text, 'main'),
    markRead: (userId, roomId, ts) => markRoomReadForUser(userId, roomId, ts),
    broadcast: (roomId, msg) => broadcast(roomId, msg),
    inbound: null,
    send: sendRunnerFrame,
    redact: redactSensitiveData,
    activeTurns: getActiveTurns,
  };
}

/** The adapter's status frame, as the chat view receives it. */
function statusFrame(msg: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'chat.status',
    event: String(msg.event ?? ''),
    text: typeof msg.text === 'string' ? msg.text : null,
    detail: typeof msg.detail === 'string' ? msg.detail : null,
    agentName: typeof msg.agent_name === 'string' ? msg.agent_name : null,
  };
}

/** Wire the router hook (server.ts owns it) and start mirroring room messages to open chat views. */
export function setupRunnerChat(inbound: ChatDeps['inbound'], override?: Partial<ChatDeps>): void {
  deps = { ...defaultDeps(), ...override, inbound };
  unsubscribe?.();
  unsubscribe = onRoomMessage((roomId, msg) => {
    for (const [fp, open] of openRooms) if (open === roomId) deps.send(fp, { ...msg, type: 'chat.message' });
  });
  unsubscribeStatus?.();
  unsubscribeStatus = onRoomStatus((roomId, msg) => {
    for (const [fp, open] of openRooms) if (open === roomId) deps.send(fp, statusFrame(msg));
  });
}

export function __resetRunnerChatForTest(): void {
  openRooms.clear();
  unsubscribe?.();
  unsubscribe = null;
  unsubscribeStatus?.();
  unsubscribeStatus = null;
  deps = defaultDeps();
}

export function closeRunnerChat(fingerprint: string): void {
  openRooms.delete(fingerprint);
}

/** Returns true when the frame was a chat frame (handled or refused). */
export function handleChatFrame(
  runner: { fingerprint: string; userId: string; displayName: string },
  frame: Record<string, unknown>,
): boolean {
  if (typeof frame.type !== 'string' || !frame.type.startsWith('chat.')) return false;
  void (async () => {
    const fail = (message: string) => deps.send(runner.fingerprint, { type: 'chat.error', message });
    try {
      if (frame.type === 'chat.open') {
        const room = await deps.roomForMachine(runner.fingerprint);
        if (!room) return fail('no agent group is placed on this machine yet');
        if (!(await deps.canAccess(runner.userId, room.id)))
          return fail('you do not have access to this machine’s room');
        openRooms.set(runner.fingerprint, room.id);
        const messages = (await deps.history(room.id, HISTORY)).map((m) => ({ ...m, content: deps.redact(m.content) }));
        deps.send(runner.fingerprint, { type: 'chat.room', roomId: room.id, name: room.name, messages });
        // Opened mid-turn: show the agent as working now, not only from its next step.
        for (const agentName of deps.activeTurns(room.id)) {
          deps.send(runner.fingerprint, statusFrame({ event: 'start', agent_name: agentName || null }));
        }
        return;
      }
      if (frame.type === 'chat.send') {
        const roomId = openRooms.get(runner.fingerprint);
        if (!roomId) return fail('open the room first');
        const text = typeof frame.text === 'string' ? frame.text.trim() : '';
        if (!text) return fail('empty message');
        if (text.length > MAX_TEXT) return fail(`message too long (${text.length} > ${MAX_TEXT})`);
        if (!(await deps.canAccess(runner.userId, roomId))) return fail('you no longer have access to this room');
        const stored = await deps.store(roomId, runner.displayName, 'user', text);
        deps.markRead(runner.userId, roomId, stored.created_at);
        // Mirrors to PWA clients AND (via onRoomMessage) back to this chat view.
        await deps.broadcast(roomId, { type: 'message', ...stored });
        deps.inbound?.(
          roomId,
          {
            id: stored.id,
            kind: 'chat',
            timestamp: new Date(stored.created_at).toISOString(),
            isGroup: true,
            content: { text, sender: runner.displayName, senderId: runner.userId, senderName: runner.displayName },
          } as InboundMessage,
          threadToSessionKey('main'),
        );
        return;
      }
      fail(`unknown chat op ${frame.type}`);
    } catch (err) {
      log.warn('Runner chat: frame failed', { fingerprint: runner.fingerprint.slice(0, 12), type: frame.type, err });
      fail('chat failed on central; see its log');
    }
  })();
  return true;
}
