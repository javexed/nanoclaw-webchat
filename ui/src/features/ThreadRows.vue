<script setup lang="ts">
/**
 * The thread tree nested under a room row; `active` selects the active room's variant
 * (rename, kebab, inline "+"). The "+" is replaced by the input while creating, sits on
 * the ROOM row's actions when there are no threads (RoomList renders it; an empty
 * .thread-list collapses via :empty), and inside the last thread row otherwise.
 */
import { computed } from 'vue';
import { state } from '../core/state.js';
import ThreadNameInput from './ThreadNameInput.vue';
import { lucide } from '../core/dom.js';
import { openThreadMenuId, threadUndo } from './room-list-state.js';
import UndoTimer from './UndoTimer.vue';

const KEBAB = lucide('ellipsis');
/** Bound, not template text — template text carries the surrounding newlines. */
const RENAME = 'Rename';
const DELETE = 'Delete';

const props = defineProps<{
  roomId: string;
  active: boolean;
  /** Per-thread identity hue for the spine, mirroring the rooms' colored bar. */
  color: (id: string) => string;
  onOpen: (threadId: string) => void;
  onCreate: (title: string) => void;
  onCancelCreate: () => void;
  onStartCreate: () => void;
  onRename: (threadId: string, title: string) => void;
  onCancelRename: () => void;
  onMenu: (threadId: string) => void;
  onStartRename: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  /** Countdown length for an armed delete — the same UNDO_SECONDS the drafts use. */
  undoSeconds: number;
  onUndoDelete: (threadId: string) => void;
}>();

const NEW_THREAD = 'New thread';
const PLUS = '+';

/** Only non-main threads render as rows — the room row IS the main thread. */
const rows = computed(() => {
  const all = state.threadCache.get(props.roomId);
  // Not an array = not fetched yet.
  if (!Array.isArray(all)) return null;
  return all.filter((t: any) => t.kind !== 'main');
});

const glyph = (kind?: string) => (kind === 'agent' ? '@' : '#');

/** Only the Undo BUTTON stops the click; elsewhere on the bar a click still opens the thread. */
function stopUndoClick(e: MouseEvent): void {
  if ((e.target as Element | null)?.closest('button')) e.stopPropagation();
}
</script>

<template>
  <div v-if="rows === null" class="thread-loading">Loading…</div>
  <template v-else>
    <template v-for="(t, i) in rows" :key="t.thread_id">
      <div
        v-if="active && t.thread_id === state.threadRenaming"
        class="thread-row"
        :data-thread-id="t.thread_id"
        :style="{ '--thread-color': color(t.thread_id) }"
      >
        <ThreadNameInput
          :value="t.title"
          aria-label="Rename thread"
          :select-all="true"
          @submit="(title) => onRename(t.thread_id, title)"
          @cancel="onCancelRename"
        />
      </div>
      <div
        v-else
        :class="[
          active && t.thread_id === state.currentThread ? 'thread-row active' : 'thread-row',
          threadUndo[t.thread_id] ? 'deleting' : '',
        ]"
        :data-thread-id="t.thread_id"
        role="button"
        tabindex="0"
        :aria-label="`Open thread ${t.title}`"
        v-bind="active && t.thread_id === state.currentThread ? { 'aria-current': 'true' } : {}"
        :style="{
          '--thread-color': color(t.thread_id),
          width: threadUndo[t.thread_id]?.width || undefined,
        }"
        @click.stop="onOpen(t.thread_id)"
        @keydown="
          (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onOpen(t.thread_id);
            }
          }
        "
      >
        <UndoTimer
          v-if="threadUndo[t.thread_id]"
          :label="threadUndo[t.thread_id].label"
          :seconds="props.undoSeconds"
          @commit="threadUndo[t.thread_id].commit()"
          @undo="props.onUndoDelete(t.thread_id)"
          @click="stopUndoClick"
        /><template v-else
          ><span class="thread-glyph" aria-hidden="true">{{ active ? glyph(t.kind) : '#' }}</span
        ><span class="thread-label">{{ t.title ?? '' }}</span
        ><span
          v-if="active && t.thread_id !== state.currentThread && state.threadUnread.has(t.thread_id)"
          class="thread-unread"
        ></span
        ><button
          v-if="active && t.kind !== 'main'"
          class="thread-kebab"
          type="button"
          aria-label="Thread actions"
          @click.stop="onMenu(t.thread_id)"
          v-html="KEBAB"
        ></button
        ><button
          v-if="active && !state.threadCreating && i === rows.length - 1"
          class="thread-add-inline"
          type="button"
          :title="NEW_THREAD"
          :aria-label="NEW_THREAD"
          @click.stop="onStartCreate"
        >{{ PLUS }}</button>
        <div v-if="active && openThreadMenuId === t.thread_id" class="thread-menu">
            <button @click.stop="onStartRename(t.thread_id)">{{ RENAME }}</button>
            <button v-if="state.isOwnerView" class="danger" @click.stop="onDelete(t.thread_id)">{{ DELETE }}</button>
          </div>
        </template>
      </div>
    </template>
    <ThreadNameInput
      v-if="active && state.threadCreating"
      aria-label="New thread name"
      @submit="onCreate"
      @cancel="onCancelCreate"
    />
  </template>
</template>
