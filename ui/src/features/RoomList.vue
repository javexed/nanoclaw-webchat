<script setup lang="ts">
/**
 * The sidebar room list — twenty-sixth island, and the largest.
 *
 * Mounted into <ul id="room-list">, exclusively owned by this module.
 *
 * Four renderers shared this subtree and had to convert together, entangled in
 * BOTH directions: renderRooms built the rows and the .thread-list hosts;
 * renderRoomThreads filled a non-active room's host; renderThreadList filled the
 * active room's AND reached back OUT to append the inline "+" into that row's
 * .room-actions; openThreadMenu appended a menu into a thread row.
 *
 * Two things the imperative version needed and this does not:
 *   - the 400ms RETRY when a kebab menu was open. The menu was a DOM node inside
 *     the list, so a background re-render (a message landing in any room) tore
 *     it down mid-click; the code deferred the whole update instead. The menu is
 *     state now, so a re-render preserves it.
 *   - the scrollTop save/restore around the rebuild. Rows are keyed and patched
 *     rather than replaced, so the scroll position is never lost to begin with.
 *
 * Element ORDER inside a row is exact and non-obvious, taken from the sequence
 * of appends: [chevron], name, [mention|unread], [pin], [thread input], actions,
 * [thread list], [kebab menu last].
 */
import { computed } from 'vue';
import { state } from '../core/state.js';
import { lucide } from '../core/dom.js';
import ThreadRows from './ThreadRows.vue';
import ThreadNameInput from './ThreadNameInput.vue';
import { draggedPinId, dropMarker, openMenuRoomId, roomFilter, roomSortAz, showArchived, showHidden } from './room-list-state.js';

const props = defineProps<{
  activityOf: (r: any) => number;
  color: (id: string) => string;
  onJoin: (roomId: string, name?: string) => void;
  onPin: (roomId: string, pin: boolean) => void;
  onMovePin: (roomId: string, delta: number) => void;
  onReorderPin: (moved: string, target: string, after: boolean) => void;
  onHide: (roomId: string, hide: boolean) => void;
  onArchive: (roomId: string, archive: boolean) => void;
  onToggleThreads: (roomId: string) => void;
  onStartAddThread: (roomId: string) => void;
  onCreateThread: (roomId: string, title: string) => void;
  onCancelAddThread: () => void;
  thread: any;
  /** Countdown length for an armed thread delete, passed straight to ThreadRows. */
  undoSeconds: number;
  onUndoDelete: (threadId: string) => void;
}>();

const KEBAB = lucide('ellipsis');
const PIN_ICON = lucide('pin');
const PLUS = '+';
const NEW_THREAD = 'New thread';
const MENTION = '@';
/**
 * Empty list. A label, not an explanation — matching `'No rooms yet.'` as it
 * already reads in the agents pane and the topology canvas. It was briefly two
 * role-dependent sentences telling a member to go find an owner; DESIGN.md's
 * rule is label-only by default, and the sidebar is the last place that earns
 * an exception.
 */
const EMPTY = 'No rooms yet.';
/** A filter that matches nothing is a different state from an empty install. */
const NO_MATCH = 'No rooms match.';
/** Bound, never template text — template text carries surrounding newlines. */
const MOVE_UP = 'Move up';
const MOVE_DOWN = 'Move down';

const byActivity = (a: any, b: any) => props.activityOf(b) - props.activityOf(a);
/** A–Z sorts by the DISPLAYED `#id`, not the room name. */
const byName = (a: any, b: any) => String(a.id).localeCompare(String(b.id));

/**
 * Name filter, applied BEFORE the pinned/archived grouping so a filtered list
 * keeps its structure — a pinned room that matches stays pinned and stays on
 * top, rather than collapsing into one flat list of hits.
 *
 * Matches the room's `#id` (what the sidebar actually displays) and its name,
 * because operators refer to rooms by both.
 */
const matchesFilter = (r: any, q: string) =>
  !q || String(r.id ?? '').toLowerCase().includes(q) || String(r.name ?? '').toLowerCase().includes(q);

const groups = computed(() => {
  const cmp = roomSortAz.value ? byName : byActivity;
  const q = roomFilter.value.trim().toLowerCase();
  const all = (state.lastRoomsList ?? []).filter((r: any) => matchesFilter(r, q));
  const visible = showHidden.value ? [...all] : all.filter((r: any) => !r.hidden);
  const active = visible.filter((r: any) => !r.archived);
  // Pinned rooms hold the user's MANUAL drag order (pin_position); the rest
  // follow the active sort. Fall back to activity when positions tie.
  const pinned = active
    .filter((r: any) => r.pinned)
    .sort((a: any, b: any) => (a.pin_position ?? 0) - (b.pin_position ?? 0) || byActivity(a, b));
  const unpinned = active.filter((r: any) => !r.pinned).sort(cmp);
  const archived = visible.filter((r: any) => r.archived).sort(cmp);
  return { pinned, unpinned, archived };
});

/** Divider sentinel — only when BOTH groups are non-empty. */
const showDivider = computed(() => groups.value.pinned.length > 0 && groups.value.unpinned.length > 0);

const rendered = computed(() => [
  ...groups.value.pinned,
  ...groups.value.unpinned,
  ...(showArchived.value ? groups.value.archived : []),
]);

/** Index within the pinned group — drives Move up / Move down availability. */
const pinIndex = (id: string) => groups.value.pinned.findIndex((r: any) => r.id === id);

/**
 * Pinning is drag-and-drop; the kebab keeps Unpin for pinned rooms. On touch —
 * where HTML5 drag is unreliable — also keep a Pin action so mobile can pin.
 */
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

function onDragStart(room: any, e: DragEvent) {
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', room.id);
    e.dataTransfer.effectAllowed = 'move';
  }
  const list = document.getElementById('room-list')!;
  if (room.pinned) {
    draggedPinId.value = room.id;
    list.classList.add('room-list-reordering');
  } else {
    draggedPinId.value = null;
    list.classList.add('room-list-dragging');
  }
}

function onDragEnd() {
  draggedPinId.value = null;
  const list = document.getElementById('room-list')!;
  list.classList.remove('room-list-dragging', 'room-list-reordering');
  dropMarker.value = {};
}

/** Above or below, decided by which half of the row the cursor is over. */
function overHalf(el: HTMLElement, y: number) {
  const rect = el.getBoundingClientRect();
  return y > rect.top + rect.height / 2;
}

function onRowDragOver(room: any, e: DragEvent) {
  if (!draggedPinId.value || draggedPinId.value === room.id) return;
  e.preventDefault();
  e.stopPropagation(); // don't bubble to the list-level pin-drop handler
  dropMarker.value = { [room.id]: overHalf(e.currentTarget as HTMLElement, e.clientY) ? 'after' : 'before' };
}

function onRowDragLeave(room: any) {
  const next = { ...dropMarker.value };
  delete next[room.id];
  dropMarker.value = next;
}

function onRowDrop(room: any, e: DragEvent) {
  if (!draggedPinId.value || draggedPinId.value === room.id) return;
  e.preventDefault();
  e.stopPropagation();
  const after = overHalf(e.currentTarget as HTMLElement, e.clientY);
  const moved = draggedPinId.value;
  draggedPinId.value = null;
  dropMarker.value = {};
  document.getElementById('room-list')!.classList.remove('room-list-reordering');
  props.onReorderPin(moved, room.id, after);
}

/**
 * Built as a string and bound through v-bind of an object, so a row with NO
 * classes emits no class attribute at all. :class="" would emit class="" —
 * the difference the very first island was caught on.
 */
function rowClass(room: any) {
  const marker = dropMarker.value[room.id];
  const parts = [
    room.archived ? 'archived' : '',
    room.id === state.currentRoom ? 'active' : '',
    marker ? 'drop-' + marker : '',
    // A row hosting a .thread-list needs less bottom padding: that padding is
    // breathing room under a room NAME, and once threads follow it lands under
    // the thread block instead, where the rows already carry their own. Marked
    // here rather than matched with :has() so the rule keys off the same
    // condition that renders the list. Both branches count — the expanded tree
    // and the inline new-thread input share one container.
    expanded(room) || adding(room) ? 'has-threads' : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

function toggleMenu(room: any) {
  openMenuRoomId.value = openMenuRoomId.value === room.id ? null : room.id;
}

function onKey(e: KeyboardEvent, room: any) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    props.onJoin(room.id, room.name);
  }
}

/** A room shows its inline new-thread input instead of the "+". */
const adding = (room: any) => state.threadAddRoom === room.id && room.id !== state.currentRoom;
/** Expanded rooms nest a tree; the active room's is expanded on join. */
const expanded = (room: any) => state.expandedRooms.has(room.id);
/** The active room's "+" moves onto the last thread row once threads exist. */
const activeHasThreads = computed(() =>
  ((state.threadCache.get(state.currentRoom!) as any[]) ?? []).some((t: any) => t.kind !== 'main'),
);
</script>

<template>
  <!--
    Empty state. Load-bearing for non-owners: "+ New room" is owner-only and is
    now hidden for them, so without this a member with no rooms gets a blank
    sidebar and no idea what to do next. Owners keep the button, so they are
    told to use it rather than to go find themselves.
  -->
  <li v-if="rendered.length === 0" class="room-list-empty">{{ roomFilter.trim() ? NO_MATCH : EMPTY }}</li>
  <template v-for="room in rendered" :key="room.id">
    <li v-if="showDivider && room.id === groups.unpinned[0]?.id" class="room-divider" role="separator"></li>
    <li
      :data-room-id="room.id"
      :draggable="!room.archived || undefined"
      role="button"
      tabindex="0"
      :style="{ borderLeftColor: color(room.id) }"
      v-bind="rowClass(room) ? { class: rowClass(room) } : {}"
      @click="onJoin(room.id, room.name)"
      @keydown="onKey($event, room)"
      @dragstart="onDragStart(room, $event)"
      @dragend="onDragEnd"
      @dragover="room.pinned ? onRowDragOver(room, $event) : undefined"
      @dragleave="room.pinned ? onRowDragLeave(room) : undefined"
      @drop="room.pinned ? onRowDrop(room, $event) : undefined"
    >
      <button
        v-if="(room.thread_count || 0) > 0"
        class="room-thread-toggle"
        type="button"
        :title="`${room.thread_count} thread${room.thread_count === 1 ? '' : 's'}`"
        :aria-label="`${expanded(room) ? 'Collapse' : 'Show'} ${room.thread_count} thread${room.thread_count === 1 ? '' : 's'}`"
        :aria-expanded="expanded(room) ? 'true' : 'false'"
        @click.stop="onToggleThreads(room.id)"
      >{{ expanded(room) ? '▾' : '▸' }}</button>
      <span class="room-row-name">#{{ room.id }}</span>
      <span v-if="state.mentionedRooms.has(room.id)" class="mention-dot" title="You were mentioned here">{{ MENTION }}</span>
      <span v-else-if="state.unreadRooms.has(room.id)" class="unread-dot" :style="{ background: color(room.id) }"></span>
      <span v-if="room.pinned" class="room-pin-indicator" aria-label="Pinned" v-html="PIN_ICON"></span>
      <div v-if="adding(room)" class="thread-list">
        <ThreadNameInput
          :aria-label="`New thread in #${room.id}`"
          @submit="(title) => onCreateThread(room.id, title)"
          @cancel="onCancelAddThread"
        />
      </div>
      <span class="room-actions">
        <button class="room-kebab" type="button" aria-label="Room actions" @click.stop="toggleMenu(room)" v-html="KEBAB"></button>
        <button
          v-if="room.id !== state.currentRoom && !adding(room)"
          class="thread-add-inline"
          type="button"
          :title="NEW_THREAD"
          :aria-label="`New thread in #${room.id}`"
          @click.stop="onStartAddThread(room.id)"
        >{{ PLUS }}</button>
        <button
          v-else-if="room.id === state.currentRoom && expanded(room) && !state.threadCreating && !activeHasThreads"
          class="thread-add-inline"
          type="button"
          :title="NEW_THREAD"
          aria-label="New thread"
          @click.stop="thread.startCreate()"
        >{{ PLUS }}</button>
      </span>
      <div v-if="expanded(room)" class="thread-list">
        <ThreadRows
          :room-id="room.id"
          :active="room.id === state.currentRoom"
          :color="color"
          :on-open="thread.open"
          :on-create="thread.create"
          :on-cancel-create="thread.cancelCreate"
          :on-start-create="thread.startCreate"
          :on-rename="thread.rename"
          :on-cancel-rename="thread.cancelRename"
          :on-menu="thread.menu"
          :on-start-rename="thread.startRename"
          :on-delete="thread.remove"
          :undo-seconds="props.undoSeconds"
          :on-undo-delete="props.onUndoDelete"
        />
      </div>
      <div v-if="openMenuRoomId === room.id" class="room-menu">
        <button
          v-if="room.pinned || coarsePointer"
          type="button"
          @click.stop="
            openMenuRoomId = null;
            onPin(room.id, !room.pinned);
          "
        >{{ room.pinned ? 'Unpin' : 'Pin' }}</button>
        <button
          v-if="room.pinned && groups.pinned.length > 1 && pinIndex(room.id) > 0"
          type="button"
          @click.stop="
            openMenuRoomId = null;
            onMovePin(room.id, -1);
          "
        >{{ MOVE_UP }}</button>
        <button
          v-if="room.pinned && groups.pinned.length > 1 && pinIndex(room.id) < groups.pinned.length - 1"
          type="button"
          @click.stop="
            openMenuRoomId = null;
            onMovePin(room.id, 1);
          "
        >{{ MOVE_DOWN }}</button>
        <button
          type="button"
          @click.stop="
            openMenuRoomId = null;
            onHide(room.id, !room.hidden);
          "
        >{{ room.hidden ? 'Unhide' : 'Hide' }}</button>
        <button
          v-if="room.canArchive"
          type="button"
          @click.stop="
            openMenuRoomId = null;
            onArchive(room.id, !room.archived);
          "
        >{{ room.archived ? 'Unarchive' : 'Archive' }}</button>
      </div>
    </li>
  </template>
</template>
