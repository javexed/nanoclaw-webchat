// ── Room list view state ────────────────────────────────────────────────────
// The sidebar's own state. Rooms, threads, unread/mention sets and the like
// live in core/state.ts; this holds the rest.
import { ref } from 'vue';

/** A–Z toggle: alphabetical by the displayed `#id` when on, activity when off.
 *  Restored from the session so the preference survives a reload. */
export const roomSortAz = ref(sessionStorage.getItem('webchat:roomSortAz') === '1');
/** Per-user "hide" reveal toggle, restored from the session. */
export const showHidden = ref(sessionStorage.getItem('webchat:showHidden') === '1');
/** Archived section reveal toggle, restored from the session. */
export const showArchived = ref(sessionStorage.getItem('webchat:showArchived') === '1');

/**
 * The pinned room currently being dragged, or null.
 *
 * Drag has two modes and they must not fire together: an UNPINNED row dragged
 * onto the list pins it (list-level drop, gated on .room-list-dragging), a
 * PINNED row dragged over another pinned row reorders (row-level, gated on
 * .room-list-reordering plus this id).
 */
export const draggedPinId = ref<string | null>(null);

/** Which row's kebab menu is open, or null. At most one across the list; held
 *  as state so a background re-render does not tear the menu down mid-click. */
export const openMenuRoomId = ref<string | null>(null);

/** Which thread's kebab menu is open, or null. */
export const openThreadMenuId = ref<string | null>(null);

/** Row showing a drop-marker during a pinned reorder: id → 'before' | 'after'. */
export const dropMarker = ref<Record<string, 'before' | 'after'>>({});

/**
 * Threads with a delete countdown armed, keyed by thread_id. ThreadRows renders
 * the timer from this rather than anything swapping its vnode-managed children.
 * `width` is measured BEFORE the swap and pinned on the row: measuring after
 * would read the timer's own width.
 */
export const threadUndo = ref<
  Record<string, { label: string; width: string; commit: () => void }>
>({});

/**
 * Live room-name filter, driven by the sidebar search box. Deliberately NOT
 * debounced and never sent anywhere: names are client-side, so the list narrows
 * on the keystroke while the message search under it waits out its 250ms.
 */
export const roomFilter = ref('');

export const selectedRoomId = ref<string | null>(null);
/** The server has sent the room list at least once: an empty list is then really empty. */
export const roomsReceived = ref(false);
/** Tool calls seen this turn — the learning nudge fires above a threshold. */
export const learnTurnToolCount = ref(0);
/** room id → auto-learn setting. Mutated in place as rooms answer, never
 *  replaced, so it stays a plain Map. */
export const roomAutoLearn = new Map<string, unknown>();
