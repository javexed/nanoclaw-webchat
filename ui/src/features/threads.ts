// ── Threads ──────────────────────────────────────────────────────────────────
// Per-room threads: the room list disclosure, the thread switcher, and the
// create / rename / delete / sync lifecycle. Second-loosest cluster in
// legacy.js by measured coupling.
//
// Injection for the legacy helpers it still reaches back to, as in the
// earlier phases; these become ordinary imports once transcript comes out.
import { $, lucide, lucideEl, esc, cssEscape } from '../core/dom.js';
import { beginTranscriptSwitch } from './transcript.js';
import { UNDO_SECONDS } from '../core/constants.js';
import { state } from '../core/state.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { createApp } from 'vue';
import ThreadSwitcher from './ThreadSwitcher.vue';
import { openThreadMenuId, threadUndo } from './room-list-state.js';

/**
 * What this module needs from legacy. Generated from its own `deps.*` uses and
 * the provideThreadsDeps block that supplies them, then narrowed by hand where
 * the shape is actually known. `any` here is a placeholder for a legacy
 * function that has not been converted yet — not a decision to stop checking.
 */
export interface ThreadsDeps {
  hideOtherFullViews: () => any;
  joinRoom: (a0?: any, a1?: any, a2?: any, a3?: any) => any;
  renderRooms: (a0?: any) => any;
  roomColor: (a0?: any) => any;
  showConfirmModal: (a0?: any, a1?: any, a2?: any, a3?: any, a4?: any) => any;
}

const deps = {} as ThreadsDeps;

/** Wire the legacy helpers this module calls. Call once at startup. */
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
    const r = await authFetch(`/api/rooms/${encodeURIComponent(roomId!)}/threads`);
    state.threadCache.set(roomId, r.ok ? ((await r.json()) ?? []) : []);
  } catch {
    state.threadCache.set(roomId, []);
  }
}

// Render an expanded non-active room's thread rows into its .thread-list host.
// Tapping a row enters that room AND the thread in a single clean join.

export async function loadThreadList(roomId?: any) {
  try {
    const r = await authFetch(`/api/rooms/${encodeURIComponent(roomId!)}/threads`);
    if (roomId !== state.currentRoom) return; // raced past a room switch
    if (!r.ok) {
      state.threadCache.set(roomId, []);
      // 404 = the room is gone (e.g. deleted in another tab / this session).
      // That's stale client state, not a failure — stay quiet; the room list
      // refresh will drop it. Only real errors get a toast.
      if (r.status !== 404) showToast('Could not load threads', { kind: 'error' });
      return;
    }
    const threads = await r.json();
    const list = Array.isArray(threads) ? threads : [];
    state.threadCache.set(roomId, list);
    for (const t of list) if (t.unread && t.thread_id !== state.currentThread) state.threadUnread.add(t.thread_id);
    updateThreadSyncControls(); // refresh the breadcrumb title (covers rename + late load)
  } catch {
    if (roomId !== state.currentRoom) return;
    state.threadCache.set(roomId, []);
    showToast('Could not load threads', { kind: 'error' });
  }
}

function threadGlyph(kind?: any) {
  return kind === 'agent' ? '@' : '#';
}

// Render the thread tree under the active room's sidebar row. Called from
// renderRooms (so it survives room-list re-renders) and on thread changes.

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
// it has nothing of its own to pull/push. See thread-context-sync.md.
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
    // join, so main's transcript can't bleed in (the old joinRoom+openThread
    // double-join race). Same room → openThread (one join into the thread);
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

// Inline "new thread" input on a NON-active room's row — dropped onto its own
// full-width line via the reused .thread-list wrap, so it's reachable from the
// room list on both desktop and mobile. Submit creates the thread in that room
// and switches into it.
// Shared inline thread-name input (create + rename). Builds the styled input and
// wires the common behavior — Enter=submit, Escape=cancel, click-stop, blur, and
// autofocus — so the four call sites only supply value/aria + their onSubmit /
// onCancel. `blurSubmits` commits on blur (the switcher) instead of cancelling;
// `selectAll` pre-selects the text (rename). An empty or unchanged value cancels.



function closeThreadMenus() {
  document.querySelectorAll('.thread-menu').forEach((m) => m.remove());
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

// Open the inline rename input on a thread row (no native prompt() — DESIGN.md §4).
function startThreadRename(thread?: any) {
  state.threadRenaming = thread.thread_id;
  state.threadCreating = false;
}

// Build a thread row showing an inline rename input, mirroring the create input.

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
// the safe default. Falls back to the old confirm modal when no row is on
// screen to host the countdown.
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
  // Measured BEFORE the swap, as armUndo did — after would read the timer's own
  // width. The .deleting class and the restore-on-Undo both come from the row
  // rendering the armed branch now, so neither is applied by hand.
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

/** The countdown length, read through the dep threads.ts already owns. */
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
    const r = await authFetch(
      `/api/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(thread)}/${direction}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    );
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const { copied = 0 } = await r.json();
    if (copied === 0) showToast(isPull ? 'Nothing new to pull' : 'Nothing new to push', { kind: 'info' });
    else showToast(`Copied ${copied} message${copied === 1 ? '' : 's'}`, { kind: 'success' });
  } catch (err) {
    showToast('Sync failed: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

// Moved in with the switcher: nothing outside threads called it.
// Replace the "+ New thread" row with an inline name input (no native prompt).

function makeThreadNameInput({
  value = '',
  placeholder = 'Thread name…',
  ariaLabel,
  selectAll = false,
  blurSubmits = false,
  onSubmit,
  onCancel,
}: any) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'thread-add-input';
  input.maxLength = 80;
  if (value) input.value = value;
  else input.placeholder = placeholder;
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
  let settled = false;
  const cancel = () => {
    if (settled) return;
    settled = true;
    onCancel?.();
  };
  const submit = () => {
    if (settled) return;
    const title = input.value.trim();
    if (!title || title === value) return cancel(); // empty or unchanged → cancel
    settled = true;
    onSubmit(title);
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', blurSubmits ? submit : cancel);
  setTimeout(() => {
    input.focus();
    if (selectAll) input.select();
  }, 0);
  return input;
}

/**
 * The thread actions the RoomList island calls. Bundled as one object because
 * the island takes them as a single `thread` prop — twelve separate props for
 * one cohesive surface reads worse and drifts more easily.
 *
 * renderThreadList/renderRoomThreads used to be the re-render trigger after
 * each of these; the island re-renders from state instead, so the calls that
 * only existed to repaint are gone.
 */
export const threadActions = {
  open: (threadId: string) => openThread(threadId),
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
