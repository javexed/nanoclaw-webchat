// ── Threads ──────────────────────────────────────────────────────────────────
// Per-room threads: the room list disclosure, the thread switcher, and the
// create / rename / delete / sync lifecycle.
import { $, cssEscape } from '../core/dom.js';
import { beginTranscriptSwitch } from './transcript.js';
import { UNDO_SECONDS } from '../core/constants.js';
import { state } from '../core/state.js';
import { showToast } from '../core/toast.js';
import { apiJson } from '../core/api.js';
import { createApp } from 'vue';
import ThreadSwitcher from './ThreadSwitcher.vue';
import { openThreadMenuId, threadUndo } from './room-list-state.js';

/** Supplied by provideThreadsDeps in composition-root.ts. `any` marks a signature not
 *  yet typed, not an opt-out of checking. */
export interface ThreadsDeps {
  hideOtherFullViews: () => any;
  joinRoom: (a0?: any, a1?: any, a2?: any, a3?: any) => any;
  renderRooms: (a0?: any) => any;
  roomColor: (a0?: any) => any;
  showConfirmModal: (a0?: any, a1?: any, a2?: any, a3?: any, a4?: any) => any;
}

const deps = {} as ThreadsDeps;

/** Wire the composition-root helpers this module calls. Call once at startup. */
export function provideThreadsDeps(provided: Partial<ThreadsDeps>): void {
  Object.assign(deps, provided);
}

export function roomThreads() {
  return state.threadCache.get(state.currentRoom!) || [];
}

// Expand/collapse a non-active room's thread tree inline in the sidebar (the
// "▸/▾" chevron), lazy-loading that room's threads on first expand.
export function toggleRoomThreads(roomId?: any) {
  if (state.expandedRooms.has(roomId)) {
    state.expandedRooms.delete(roomId);
    deps.renderRooms(state.lastRoomsList);
    return;
  }
  state.expandedRooms.add(roomId);
  if (!state.threadCache.has(roomId)) {
    void loadRoomThreads(roomId).then(() => {
      if (state.expandedRooms.has(roomId)) deps.renderRooms(state.lastRoomsList);
    });
  }
  deps.renderRooms(state.lastRoomsList); // immediate (shows "Loading…" until the fetch resolves)
}

export async function loadRoomThreads(roomId?: any) {
  try {
    state.threadCache.set(roomId, (await apiJson(`/api/rooms/${encodeURIComponent(roomId!)}/threads`)) ?? []);
  } catch {
    state.threadCache.set(roomId, []);
  }
}

export async function loadThreadList(roomId?: any) {
  try {
    const threads = await apiJson(`/api/rooms/${encodeURIComponent(roomId!)}/threads`);
    if (roomId !== state.currentRoom) return; // raced past a room switch
    const list = Array.isArray(threads) ? threads : [];
    state.threadCache.set(roomId, list);
    for (const t of list) if (t.unread && t.thread_id !== state.currentThread) state.threadUnread.add(t.thread_id);
    updateThreadSyncControls(); // refresh the breadcrumb title (covers rename + late load)
  } catch (err: any) {
    if (roomId !== state.currentRoom) return;
    state.threadCache.set(roomId, []);
    // 404 = the room is gone (e.g. deleted in another tab / this session).
    // That's stale client state, not a failure — stay quiet; the room list
    // refresh will drop it. Only real errors get a toast.
    if (err?.status !== 404) showToast('Could not load threads', { kind: 'error' });
  }
}

function openThread(threadId?: any) {
  if (!state.currentRoom || threadId === state.currentThread) return;
  // Make the chat pane visible — on mobile, opening a thread from the room-list
  // view must switch INTO the chat (mirror joinRoom), otherwise the click just
  // changes state behind the still-shown sidebar and looks like it did nothing.
  deps.hideOtherFullViews();
  $('#chat')!.hidden = false;
  $('#app')!.classList.add('in-room');
  $('#app')!.classList.remove('in-dashboard');
  state.currentThread = threadId;
  localStorage.setItem('lastThread:' + state.currentRoom, threadId);
  state.threadUnread.delete(threadId);
  beginTranscriptSwitch();
  // Re-join the room scoped to this thread; the server returns thread history.
  // Guarded on OPEN for the same reason as joinRoom: send() on a connecting
  // socket throws, which would skip updateThreadSyncControls() below and leave
  // the breadcrumb/sync controls stale. state.currentThread is already set, so
  // ws.ts's rejoin carries this thread when the socket comes up.
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'join', room_id: state.currentRoom, thread_id: threadId }));
  }
  updateThreadSyncControls();
}

// The breadcrumb + pull/push/delete controls only make sense inside a topic
// thread — the main chat ('main') is the trunk both directions sync against, so
// it has nothing of its own to pull/push. See docs/webchat/threads.md §8.
export function updateThreadSyncControls() {
  const inThread = !!(state.currentRoom && state.currentThread && state.currentThread !== 'main');
  // The header thread switcher shows whenever a room is open (CSS gates it to
  // mobile, where the sidebar thread tree is hidden in-room). Badge it with the
  // topic-thread count + accent it, so it's obvious the room HAS threads to open.
  const sw = $('#thread-switch');
  if (sw) {
    sw.hidden = !state.currentRoom;
    const topicCount = roomThreads().filter((t) => t.kind !== 'main').length;
    sw.textContent = topicCount > 0 ? `#${topicCount}` : '#';
    sw.classList.toggle('has-threads', topicCount > 0);
    sw.title = topicCount > 0 ? `${topicCount} thread${topicCount === 1 ? '' : 's'}` : 'Threads';
  }
  const sync = $('#thread-sync');
  if (sync) sync.hidden = !inThread;
  const crumb = $('#thread-crumb');
  if (crumb) {
    crumb.hidden = !inThread;
    if (inThread) {
      const thread = roomThreads().find((t) => t.thread_id === state.currentThread);
      const nameEl = $('#thread-crumb-name');
      if (nameEl) {
        nameEl.textContent = thread ? (thread.title ?? '') : state.currentThread;
        nameEl.style.setProperty('--thread-color', deps.roomColor(state.currentThread));
      }
    }
  }
}

export async function createThread(title?: any, roomId = state.currentRoom) {
  try {
    const thread = await apiJson(`/api/rooms/${encodeURIComponent(roomId!)}/threads`, {
      method: 'POST',
      body: { title },
    });
    // Create AND enter the new (blank) thread — but cleanly, via a SINGLE WS
    // join, so main's transcript can't bleed in (a joinRoom+openThread double
    // join races). Same room → openThread (one join into the thread);
    // another room → joinRoom straight into the thread.
    if (roomId === state.currentRoom) {
      await loadThreadList(roomId); // so the tree shows it as active
      openThread(thread.thread_id);
    } else {
      const room = state.lastRoomsList.find((x) => x.id === roomId);
      deps.joinRoom(roomId, room ? room.name : roomId, undefined, thread.thread_id);
    }
  } catch (err) {
    showToast('Could not create thread: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

// In-room thread switcher (the chat-header '#' button). The sidebar thread tree
// is hidden on mobile while a room is open, so this is the mobile way to switch
// between Main/topic threads and create a new one without backing out.
export function closeThreadSwitcher() {
  // Unmount before removing: the popover is a mounted app, and dropping the
  // node alone would leave its effects subscribed to something invisible.
  switcherApp?.unmount();
  switcherApp = null;
  document.querySelectorAll('.thread-switcher').forEach((m) => m.remove());
}

let switcherApp: ReturnType<typeof createApp> | null = null;

export function openThreadSwitcher() {
  closeThreadSwitcher();
  if (!state.currentRoom) return;
  const btn = $('#thread-switch');
  if (!btn) return;
  const pop = document.createElement('div');
  pop.className = 'thread-switcher';
  pop.setAttribute('role', 'menu');

  // Main chat first and never tinted; topic threads carry a dot in their
  // identity colour. openThread handles 'main' too (no-op if already there).
  const rows = [
    { label: 'Main chat', threadId: 'main', tinted: false, color: '' },
    ...roomThreads()
      .filter((t: any) => t.kind !== 'main')
      .map((t: any) => ({ label: t.title, threadId: t.thread_id, tinted: true, color: deps.roomColor(t.thread_id) })),
  ];

  switcherApp = createApp(ThreadSwitcher, {
    rows,
    currentThread: state.currentThread,
    onPick: (threadId: string) => {
      closeThreadSwitcher();
      openThread(threadId);
    },
    onCreate: (title: string) => {
      closeThreadSwitcher();
      createThread(title);
    },
    onCancel: () => closeThreadSwitcher(),
  });
  switcherApp.mount(pop);

  btn.parentElement?.appendChild(pop);
  setTimeout(() => document.addEventListener('click', closeThreadSwitcher, { once: true }), 0);
}

async function submitThreadRename(threadId?: any, title?: any) {
  try {
    await apiJson(`/api/rooms/${encodeURIComponent(state.currentRoom!)}/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      body: { title },
    });
    await loadThreadList(state.currentRoom);
  } catch (err) {
    showToast('Rename failed: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

// Thread removal uses the same sliding-undo pattern as draft Keep/Discard: the
// row swaps to a countdown; the DELETE only fires when the bar drains. Undo
// restores the row untouched, and a tab closed mid-countdown deletes nothing —
// the safe default. Falls back to a confirm modal when no row is on screen to
// host the countdown.
export async function deleteThreadConfirm(thread?: any, rowEl?: any) {
  const commit = async () => {
    try {
      await apiJson(`/api/rooms/${encodeURIComponent(state.currentRoom!)}/threads/${encodeURIComponent(thread.thread_id)}`, {
        method: 'DELETE',
      });
      if (state.currentThread === thread.thread_id) openThread('main');
      await loadThreadList(state.currentRoom);
      showToast('Thread deleted', { kind: 'success' });
    } catch (err) {
      showToast('Delete failed: ' + ((err as any)?.message || err), { kind: 'error' });
      await loadThreadList(state.currentRoom); // restore the real row state
    }
  };
  const row = rowEl || document.querySelector(`.thread-row[data-thread-id="${cssEscape(thread.thread_id)}"]`);
  if (!row) {
    const confirmed = await deps.showConfirmModal({
      title: `Delete "${thread.title}"?`,
      body: '',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (confirmed) await commit();
    return;
  }
  // Measured BEFORE the swap — after would read the timer's own width. The
  // .deleting class and restore-on-Undo come from the row's armed branch.
  const width = (row as HTMLElement).getBoundingClientRect().width;
  const id = thread.thread_id;
  threadUndo.value = {
    ...threadUndo.value,
    [id]: {
      label: `Removing ${thread.title}…`,
      width: width ? `${width}px` : '',
      commit: () => {
        clearThreadUndo(id);
        void commit();
      },
    },
  };
}

/** The countdown length (UNDO_SECONDS). */
export function getUndoSeconds(): number {
  return UNDO_SECONDS;
}

/** Disarm a thread's countdown — Undo, or the commit that follows it. */
export function clearThreadUndo(threadId: string): void {
  const next = { ...threadUndo.value };
  delete next[threadId];
  threadUndo.value = next;
}

export async function syncThread(direction?: any) {
  if (!state.currentRoom || state.currentThread === 'main') return;
  const room = state.currentRoom;
  const thread = state.currentThread;
  const isPull = direction === 'pull';
  const ok = await deps.showConfirmModal({
    title: isPull ? 'Pull main chat down' : 'Push this thread up',
    body: '',
    confirmLabel: isPull ? 'Pull down' : 'Push up',
  });
  if (!ok) return;
  try {
    const { copied = 0 } = await apiJson(
      `/api/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(thread)}/${direction}`,
      { method: 'POST' },
    );
    if (copied === 0) showToast(isPull ? 'Nothing new to pull' : 'Nothing new to push', { kind: 'info' });
    else showToast(`Copied ${copied} message${copied === 1 ? '' : 's'}`, { kind: 'success' });
  } catch (err) {
    showToast('Sync failed: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

/**
 * The thread actions the RoomList island calls, bundled as its single `thread`
 * prop. The island re-renders from state, so none of these repaint by hand.
 */
export const threadActions = {
  open: (threadId: string, roomId?: string) => {
    // A thread under another room's open tree: enter that room on the thread
    // (one join, as createThread does). openThread alone keeps the current
    // room, which opened the thread id inside it: a blank, nonexistent thread.
    if (roomId && roomId !== state.currentRoom) {
      const room = state.lastRoomsList.find((x) => x.id === roomId);
      deps.joinRoom(roomId, room ? room.name : roomId, undefined, threadId);
      return;
    }
    openThread(threadId);
  },
  create: (title: string) => {
    state.threadCreating = false;
    createThread(title);
  },
  cancelCreate: () => {
    state.threadCreating = false;
  },
  startCreate: () => {
    state.threadCreating = true;
  },
  rename: (threadId: string, title: string) => {
    state.threadRenaming = null;
    submitThreadRename(threadId, title);
  },
  cancelRename: () => {
    state.threadRenaming = null;
  },
  menu: (threadId: string) => {
    openThreadMenuId.value = openThreadMenuId.value === threadId ? null : threadId;
  },
  startRename: (threadId: string) => {
    openThreadMenuId.value = null;
    state.threadRenaming = threadId;
  },
  remove: (threadId: string) => {
    openThreadMenuId.value = null;
    const t = roomThreads().find((x: any) => x.thread_id === threadId);
    if (t) deleteThreadConfirm(t, null);
  },
};
