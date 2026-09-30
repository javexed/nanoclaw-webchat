import { ref, shallowReactive } from 'vue';

// ── Shared app state ─────────────────────────────────────────────────────────
// The mutable state the whole console reads: the socket, who I am, which room
// and thread are open, the unread/mention bookkeeping, pager cursors and the
// scroll-follow counters.
// One exported OBJECT rather than getter/setter pairs, so `state.x = 1` and
// `state.x++` work from any module. `settings` is set by composition-root.ts
// at startup (loadSettings lives in features/settings.ts, which imports this).
/** A room as the sidebar sees it: every property the room list, thread tree and
 *  ws dispatcher actually read. */
export interface Room {
  id: string;
  name?: string;
  archived?: boolean;
  hidden?: boolean;
  pinned?: boolean;
  pin_position?: number;
  unread?: boolean;
  mention?: boolean;
  thread_count?: number;
  canArchive?: boolean;
}

/** One thread inside a room. */
export interface Thread {
  thread_id: string;
  title?: string;
  kind?: string;
  unread?: boolean;
}

/** An agent as the console sees it: every property the agents list, detail pane,
 *  room wiring and ws dispatcher actually read. */
export interface Agent {
  /** Placed on a developer's machine: Network offers Open / Allowlist / Model only. */
  runner_placed?: boolean;
  id: string;
  name?: string;
  folder?: string;
  status?: string;
  provider?: string;
  egress?: string;
  is_prime?: boolean;
  created_at?: number;
  room_id?: string;
  assigned_model_id?: string | null;
  config_model?: string | null;
  /** server-rendered label for the model actually in effect */
  effective_model_label?: string;
}

/** Shape of the persisted user settings (see loadSettings in features/settings). */
export interface Settings {
  theme: string;
  font: string;
  sendKey: string;
  notifications: boolean;
  [key: string]: unknown;
}

/** The connection banner's last probe result. */
export interface Diagnosis {
  text: string;
  offer?: boolean;
}

/** The console's shared mutable state. Payloads whose shape is not pinned down
 *  are `unknown`, not `any`: widening one would silently switch off checking. */
export interface AppState {
  /** Workspace master (owner-set) — gates ALL learning UI + behaviour. */
  learningMasterEnabled: boolean;
  serverUsesTailscale: boolean;
  lastProbeAt: number;
  lastDiagnosis: Diagnosis | null;
  settings: Settings | null;
  ws: WebSocket | null;
  currentRoom: string | null;
  myIdentity: string;
  myHandle: string;
  /** client-generated id → the optimistic ROW awaiting server echo (a row, not a
   *  node, so the WS layer is never a second DOM writer). */
  pendingMessages: Map<string, any>;
  /** identity → typing-indicator timer state */
  typingUsers: Map<string, unknown>;
  unreadRooms: Set<string>;
  /** rooms with an unread @-mention of me (distinct badge) */
  mentionedRooms: Set<string>;
  agentName: string;
  lastSeenMessageId: string | null;
  reconnectDelay: number;
  /** room id → last-activity timestamp, for the sidebar's default ordering */
  roomActivity: Map<string, number>;
  lastRoomsList: Room[];
  currentThread: string;
  /** true while the inline "new thread" input is open */
  threadCreating: boolean;
  /** room id whose row is showing the inline new-thread input */
  threadAddRoom: string | null;
  /** thread_id whose row is showing the inline rename input */
  threadRenaming: string | null;
  /** thread_ids with unread activity in the open room */
  threadUnread: Set<string>;
  /** rooms whose thread tree is expanded (the active room is added on join) */
  expandedRooms: Set<string>;
  /** room id → its loaded thread list */
  threadCache: Map<string, Thread[]>;
  pendingJumpMessageId: string | null;
  /** A slash command to send once the join completes, or null (skills.ts sets
   *  '/learn <source>'). */
  pendingSendAfterJoin: string | null;
  oldestMessageId: string | null;
  loadingOlder: boolean;
  noMoreOlder: boolean;
  missedMsgCount: number;
  /** force scroll for the next N incoming messages after a send */
  forceScrollCount: number;
  /** true once the user scrolls up after sending */
  userScrolledAway: boolean;
  /** set by probeIsOwner — gates owner-only write controls */
  isOwnerView: boolean;
  /** MCP + skills catalog — opt-in; set by probeIsOwner from /api/webchat/features */
  marketplaceEnabled: boolean;
  allAgents: Agent[];
}

/**
 * shallowReactive, NOT reactive: the room list and transcript iterate the big
 * arrays constantly, and deep reactivity would allocate a proxy per element read.
 * INVARIANT: arrays are assigned wholesale — `state.rooms.push(r)` does NOT
 * re-render, `state.rooms = [...state.rooms, r]` does.
 * The Set/Map fields below are mutated in place (.add/.delete/.set/.clear), so
 * each is itself shallowReactive; under a plain shallow parent those mutations
 * would notify nothing and islands reading them would render late.
 */
export const state: AppState = shallowReactive({
  learningMasterEnabled: true, // workspace master (owner-set) — gates ALL learning UI + behavior

  // Whether this server uses Tailscale auth. Cached from /api/auth/info and
  // persisted to localStorage so the connection-lost banner can suggest starting
  // Tailscale even when the device is currently offline (cold start, no network).
  serverUsesTailscale: (() => {
      try {
        return localStorage.getItem('webchat-server-tailscale') === '1';
      } catch {
        return false;
      }
    })(),
  lastProbeAt: 0,
  lastDiagnosis: null, // { text, offer } from the most recent probe
  settings: null,
  ws: null,
  currentRoom: null,
  myIdentity: '',
  myHandle: '',
  pendingMessages: new Map(),
  typingUsers: new Map(),
  unreadRooms: shallowReactive(new Set<string>()),
  mentionedRooms: shallowReactive(new Set<string>()), // rooms with an unread @-mention of me (distinct badge)
  agentName: '',
  lastSeenMessageId: sessionStorage.getItem('lastSeenMessageId') || null,
  reconnectDelay: 1000,
  roomActivity: new Map(),
  lastRoomsList: [],
  currentThread: 'main',
  threadCreating: false, // true while the inline "new thread" input is open
  threadAddRoom: null, // room id whose row is showing the inline new-thread input
  threadRenaming: null, // thread_id whose row is showing the inline rename input
  threadUnread: shallowReactive(new Set<string>()), // thread_ids with unread activity in the open room
  expandedRooms: shallowReactive(new Set<string>()), // rooms whose thread tree is expanded in the sidebar (the active room is added on join)
  threadCache: shallowReactive(new Map<string, Thread[]>()),
  pendingJumpMessageId: null,
  pendingSendAfterJoin: null,
  oldestMessageId: null,
  loadingOlder: false,
  noMoreOlder: false,
  missedMsgCount: 0,
  forceScrollCount: 0, // force scroll for next N incoming messages after send
  userScrolledAway: false, // true once user scrolls up after sending
  isOwnerView: false, // set by probeIsOwner — gates owner-only write controls (e.g. room assignment)
  marketplaceEnabled: false, // MCP + skills catalog — disabled by default (opt-in); set by probeIsOwner from /api/webchat/features
  allAgents: [],
});

/** Is the transcript being force-followed right now? forceScrollCount is set on
 *  send so the reply scrolls into view; userScrolledAway cancels it. */
export function isForcedScroll(): boolean {
  return state.forceScrollCount > 0 && !state.userScrolledAway;
}

/**
 * Set by probeIsOwner — true for any admin, where isOwnerView is the stricter
 * owner-only flag. Both gate write controls, at different levels, which is why
 * they are two values and not one.
 */
export const isAdminView = ref(false);

/**
 * Owner or global admin: the audience for install-wide settings that every
 * agent shares (an MCP server's tools, OAuth and drift approval).
 */
export const isWorkspaceAdminView = ref(false);
