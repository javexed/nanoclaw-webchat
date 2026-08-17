// ── Room list view state ────────────────────────────────────────────────────
// The sidebar's own state. Most of what the room list renders already lives in
// core/state.ts and is reactive there — rooms, threads, unread/mention sets,
// expanded rooms, the thread being renamed. This module holds only what legacy
// still owned as module-scope variables.
import { ref } from 'vue';

/** A–Z toggle: alphabetical by the displayed `#id` when on, activity when off. */
/** Restored from the session — the sessionStorage read was the `let`'s
 *  initialiser in legacy.js, and dropping it turns a remembered preference
 *  into a per-reload default. */
export const roomSortAz = ref(sessionStorage.getItem('webchat:roomSortAz') === '1');
/** Per-user "hide" reveal toggle. */
/** Restored from the session — the sessionStorage read was the `let`'s
 *  initialiser in legacy.js, and dropping it turns a remembered preference
 *  into a per-reload default. */
export const showHidden = ref(sessionStorage.getItem('webchat:showHidden') === '1');
/** Archived section reveal toggle. */
/** Restored from the session — the sessionStorage read was the `let`'s
 *  initialiser in legacy.js, and dropping it turns a remembered preference
 *  into a per-reload default. */
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

/**
 * Which row's kebab menu is open, or null. At most one across the list.
 *
 * This is why renderRooms had a retry timer: the menu was a DOM node inside the
 * list, so any background re-render tore it down mid-click and the code
 * deferred the update by 400ms instead. As state the menu survives a re-render,
 * and the retry is gone with it.
 */
export const openMenuRoomId = ref<string | null>(null);

/** Which thread's kebab menu is open, or null. */
export const openThreadMenuId = ref<string | null>(null);

/** Row showing a drop-marker during a pinned reorder: id → 'before' | 'after'. */
export const dropMarker = ref<Record<string, 'before' | 'after'>>({});

/**
 * Threads with a delete countdown armed, keyed by thread_id.
 *
 * This replaces armUndo()'s DOM swap. armUndo was handed the ROW — not an
 * actions strip — captured its childNodes, replaced them with the timer and
 * re-appended them on Undo. ThreadRows renders those children, so that was an
 * imperative writer reinserting vnode-managed nodes behind Vue's back: the last
 * two-writers case in the codebase and the reason armUndo could not be deleted
 * with the rest of legacy.js.
 *
 * `width` is measured BEFORE the swap and pinned on the row, exactly as armUndo
 * did — measuring after would read the timer's own width and defeat the point.
 */
export const threadUndo = ref<
  Record<string, { label: string; width: string; commit: () => void }>
>({});

/** The room whose detail pane is open, or null. */
/**
 * Live room-name filter, driven by the sidebar search box as you type.
 *
 * Deliberately NOT debounced and never sent anywhere: matching a name the
 * client already holds costs nothing, so the list narrows on the keystroke
 * while the MESSAGE search under it still waits out its 250ms. One box, two
 * speeds — the fast half should not be held back by the slow one.
 */
export const roomFilter = ref('');

export const selectedRoomId = ref<string | null>(null);
/** Tool calls seen this turn — the learning nudge fires above a threshold. */
export const learnTurnToolCount = ref(0);
/** room id → auto-learn setting. Mutated in place as rooms answer, never
 *  replaced, so it stays a plain Map. */
export const roomAutoLearn = new Map<string, unknown>();
