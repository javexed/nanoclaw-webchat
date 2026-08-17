import { ref, shallowReactive } from 'vue';

// ── Shared app state ─────────────────────────────────────────────────────────
// The mutable state the whole console reads: the socket, who I am, which room
// and thread are open, the unread/mention bookkeeping, pager cursors and the
// scroll-follow counters.
//
// A single exported OBJECT rather than getter/setter pairs, deliberately.
// Every module that needed this state was being handed accessor functions by
// legacy.js — 138 call sites across ten modules — and each pair had to be
// hand-written and kept in step. Worse, converting a variable to accessors
// rewrites `x = 1` into `setX(1)` and `x++` into something that does not
// parse, which is exactly where the phase 1g regressions came from.
//
// With an object, `state.x = 1`, `state.x++` and `state.x === y` are all just
// themselves. The transformation is a rename, not a restructure, and anything
// it gets wrong (shorthand `{ ws }`, destructuring, a shadowed parameter) is a
// syntax error rather than a silent behaviour change.
//
// `settings` is initialised by legacy at startup instead of here: it comes from
// loadSettings(), which has not been extracted yet.
/**
 * A room as the sidebar sees it. Built from every property the room list,
 * thread tree and ws dispatcher actually read — the same way Approval and
 * ThinkingTurn were, and for the same reason: field names alone have been
 * wrong every time this phase guessed from them.
 */
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

/**
 * An agent as the console sees it. Built from every property the agents list,
 * detail pane, room wiring and ws dispatcher actually read — the fourth type
 * this phase has derived from use rather than from a field name, after
 * Approval, ThinkingTurn and Room.
 */
export interface Agent {
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

/**
 * The console's shared mutable state.
 *
 * Typed honestly rather than conveniently: fields whose payload shape is not
 * yet pinned down are `unknown` inside their container, not `any`. Consumers
 * are still .js and therefore unchecked, so this costs nothing today — but as
 * each module converts to TypeScript it gets checked against THIS declaration,
 * which is the point of doing state first. Widening one of these to `any` later
 * would silently switch that checking off again.
 */
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
  /** client-generated id → the optimistic ROW awaiting server echo. Was the
   *  bubble ELEMENT until the transcript became Vue-rendered; handing a node to
   *  the WS layer is what made it a second writer. */
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
  /** A slash command to send once the join completes, or null. Typed from its
   *  one producer (skills.ts sets '/learn <source>'); it was `unknown`, which
   *  only held because every consumer reached it through an `any` dep. */
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
 * shallowReactive, NOT reactive — and not a plain object any more either.
 *
 * Vue islands re-render when what they read changes, so this object has to be a
 * reactivity root. It is a one-line change only because of the phase-1h
 * decision above: every one of the ~138 call sites already writes `state.x = 1`
 * and `state.x++` against this single binding, so wrapping the literal makes all
 * of them reactive without touching any of them. Accessor pairs would have
 * needed all 138 rewritten.
 *
 * Shallow, for three reasons — none of them correctness. Deep `reactive()` is
 * SAFE here: it refuses to proxy anything outside Object/Array/Map/Set, so the
 * `WebSocket` and the `HTMLElement` values in pendingMessages come back raw
 * either way, and every identity comparison in this codebase is against a
 * string (`state.currentRoom`, `state.myIdentity`) which proxying cannot touch.
 * The reasons are:
 *
 *  1. Cost. lastRoomsList, allAgents and threadCache are iterated constantly by
 *     the room list and transcript. Deep reactivity allocates a proxy per
 *     element per read; shallow allocates none.
 *  2. pendingMessages maps ids to DOM nodes — imperative render bookkeeping,
 *     not view state. Deep reactivity would track every set() and wake effects
 *     for something no island ever reads.
 *  3. It makes an existing contract explicit for the ARRAYS. They are assigned
 *     wholesale (`state.lastRoomsList = msg.rooms`), never pushed into.
 *
 * The consequence to know: `state.rooms.push(r)` will NOT trigger a re-render.
 * `state.rooms = [...state.rooms, r]` will. That is already how this code is
 * written; island code has to keep it that way.
 *
 * Reason 3 was stated here as holding for EVERY collection, and that was wrong.
 * The five Set/Map fields below are mutated in place at twenty-five call sites
 * and never assigned wholesale — .add(), .delete(), .set(), .clear(). Under a
 * plain shallowReactive parent those mutations notify nothing, so an island
 * reading them re-rendered only when something ELSE happened to change.
 *
 * That shipped as a visible bug: clicking a room's thread-tree chevron recorded
 * the expansion and drew nothing, because renderRooms syncs three unrelated
 * refs and none of them changed. The tree appeared on the next unrelated
 * render — a rooms broadcast, a sort toggle — which is why it looked
 * intermittent rather than broken.
 *
 * So the five are individually shallowReactive. That instruments the COLLECTION
 * (add/delete/set/clear notify, has/get track) while still returning raw values
 * on read — reason 1's cost argument survives intact, which a deep reactive()
 * on threadCache would not have allowed.
 */
export const state: AppState = shallowReactive({
  learningMasterEnabled: true, // workspace master (owner-set) — gates ALL learning UI + behavior
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

/**
 * Is the transcript being force-followed right now?
 *
 * forceScrollCount is set on send so the agent's reply scrolls into view, and
 * userScrolledAway cancels it the moment the reader takes over. Both live here,
 * so the derivation does too — it reached the thinking bubble through an
 * isForcedScroll() entry on the Thinking bridge, which existed only because the
 * expression sat in legacy.js.
 */
export function isForcedScroll(): boolean {
  return state.forceScrollCount > 0 && !state.userScrolledAway;
}

/**
 * Set by probeIsOwner — true for any admin, where isOwnerView is the stricter
 * owner-only flag. Both gate write controls, at different levels, which is why
 * they are two values and not one.
 */
export const isAdminView = ref(false);
