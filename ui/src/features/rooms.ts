// ── Rooms ────────────────────────────────────────────────────────────────────
// The room list and its lifecycle: rendering and ordering (activity vs A–Z),
// pin / archive / hide, the room detail pane, search, and the create flow.
import { createApp, watchEffect } from 'vue';
import SearchResults from './SearchResults.vue';
import { searchRows } from './search-results-state.js';
import { $, esc } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { updateUserCredsBanner } from './members.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson } from '../core/api.js';
import { state } from '../core/state.js';
import { closeAgentDetail, endAllAgentTurns, fetchAgents, refreshRoomWiredAgents, refreshWiredAgentsForCurrentRoom, renderRoomCreateAgentChecklist } from './agents.js';
import { closeMcpDetail } from './mcp.js';
import { clearThreadUndo, createThread, getUndoSeconds, loadThreadList, threadActions, toggleRoomThreads, updateThreadSyncControls } from './threads.js';
import RoomList from './RoomList.vue';
import { learnTurnToolCount, roomAutoLearn, roomFilter, selectedRoomId, showArchived, showHidden } from './room-list-state.js';
import { transcriptEmpty } from './transcript-state.js';
import { beginTranscriptSwitch } from './transcript.js';

/** Supplied by provideRoomsDeps in composition-root.ts. `any` marks a signature not
 *  yet typed, not an opt-out of checking. */
export interface RoomsDeps {
  closeModelDetail: () => any;
  fetchMentionablePeople: () => any;
  hideLearnNudge: () => any;
  hideOtherFullViews: () => any;
  renderMembers: (a0?: any) => any;
  renderTypingIndicator: () => any;
  showConfirmModal: (...args: any[]) => any;
  updateUserCredsBanner: (a0?: any) => any;
}

const deps = {} as RoomsDeps;

/** Wire the composition-root helpers this module calls. Call once at startup. */
export function provideRoomsDeps(provided: Partial<RoomsDeps>): void {
  Object.assign(deps, provided);
}

const ROOM_COLORS = ['#4fc3f7', '#69f0ae', '#ffd54f', '#ff8a80', '#b388ff', '#80deea', '#ffab91', '#a5d6a7'];

export function roomColor(roomId?: any) {
  let hash = 0;
  for (let i = 0; i < roomId.length; i++) hash = ((hash << 5) - hash + roomId.charCodeAt(i)) | 0;
  return ROOM_COLORS[Math.abs(hash) % ROOM_COLORS.length];
}

export function snapshotRoomImages() {
  // Snapshot all currently-rendered file-image-previews in DOM (top-to-bottom)
  // order so prev/next walks the room's image attachments.
  const imgs = document.querySelectorAll('#messages .file-image-preview');
  return Array.from(imgs).map((el) => ({ url: (el as HTMLImageElement).src, alt: (el as HTMLImageElement).alt || '' }));
}

let roomListApp: ReturnType<typeof createApp> | null = null;

function mountRoomList(): void {
  if (roomListApp) return;
  const host = $('#room-list');
  if (!host) return;
  // Drag-to-pin: the LIST is the drop target, so these listeners live on the
  // mount point, which Vue never replaces — they survive every render.
  host.addEventListener('dragover', (e) => {
    if (!host.classList.contains('room-list-dragging')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  host.addEventListener('drop', async (e) => {
    if (!host.classList.contains('room-list-dragging')) return;
    e.preventDefault();
    const id = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
    host.classList.remove('room-list-dragging');
    if (id) await toggleRoomPin(id, true);
  });
  roomListApp = createApp(RoomList, {
    activityOf,
    color: roomColor,
    onJoin: (roomId: string, name?: string) => joinRoom(roomId, name),
    onPin: (roomId: string, pin: boolean) => void toggleRoomPin(roomId, pin),
    onMovePin: (roomId: string, delta: number) => void movePinnedRoom(roomId, delta),
    onReorderPin: (moved: string, target: string, after: boolean) => void reorderPinnedRoom(moved, target, after),
    onHide: (roomId: string, hide: boolean) => void toggleRoomHide(roomId, hide),
    onArchive: (roomId: string, archive: boolean) => void toggleRoomArchive(roomId, archive),
    onToggleThreads: (roomId: string) => toggleRoomThreads(roomId),
    onStartAddThread: (roomId: string) => {
      state.threadAddRoom = roomId;
      state.threadCreating = false;
    },
    onCreateThread: (roomId: string, title: string) => {
      state.threadAddRoom = null;
      createThread(title, roomId);
    },
    onCancelAddThread: () => {
      state.threadAddRoom = null;
    },
    thread: threadActions,
    undoSeconds: getUndoSeconds(),
    onUndoDelete: (threadId: string) => clearThreadUndo(threadId),
  });
  roomListApp.mount(host);

  // Creating a room is owner-only (`POST /api/rooms` carries guards:['owner']).
  // A watcher, not a write in renderRooms: the rooms broadcast lands before
  // probeIsOwner resolves, and with zero rooms renderRooms never runs again.
  watchEffect(() => {
    const btn = $('#create-room-btn');
    if (btn) btn.hidden = !state.isOwnerView;
  });
}

/**
 * Sync the toggles the island reads, and mount it. Rows come from the reactive
 * state.lastRoomsList; this also updates the two count buttons outside the mount.
 */
export function renderRooms(rooms?: any) {
  const all = rooms ?? state.lastRoomsList ?? [];
  mountRoomList();

  const archivedCount = (showHidden.value ? all : all.filter((r: any) => !r.hidden)).filter(
    (r: any) => r.archived,
  ).length;
  const toggleBtn = $('#archived-toggle')!;
  toggleBtn.hidden = archivedCount === 0;
  if (archivedCount) {
    toggleBtn.textContent = showArchived.value ? `Hide ${archivedCount} archived` : `Show ${archivedCount} archived`;
  }
  // Hidden-rooms toggle — mirrors the archived one. Without it a hidden room can
  // never be brought back from the GUI (the only way to un-hide is to see it first).
  const hiddenCount = all.filter((r: any) => r.hidden).length;
  const hiddenBtn = $('#hidden-toggle')!;
  hiddenBtn.hidden = hiddenCount === 0;
  if (hiddenCount) {
    hiddenBtn.textContent = showHidden.value ? `Hide ${hiddenCount} hidden` : `Show ${hiddenCount} hidden`;
  }
}

export async function toggleRoomArchive(roomId?: any, archive?: any) {
  // GLOBAL archive (owner + admin only). Optimistic: flip locally and
  // re-render immediately; server success replays the same state via
  // broadcastRooms; failure rolls back.
  const target = state.lastRoomsList.find((r) => r.id === roomId);
  if (target) target.archived = archive;
  renderRooms(state.lastRoomsList);
  try {
    await apiJson(`/api/rooms/${encodeURIComponent(roomId)}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' });
  } catch (err) {
    console.error('toggleRoomArchive failed:', err);
    if (target) target.archived = !archive; // roll back
    renderRooms(state.lastRoomsList);
  }
}

// Move a pinned room before/after another within the pinned group and persist
// the new order. Optimistic: reindex pin_position locally and re-render, then
// POST; the server's broadcastRooms re-syncs authoritative order to every device.
export async function reorderPinnedRoom(movedId?: any, targetId?: any, after?: any) {
  const order = state.lastRoomsList
    .filter((r) => r.pinned && !r.archived)
    .sort((a, b) => (a.pin_position ?? 0) - (b.pin_position ?? 0))
    .map((r: any) => r.id);
  const from = order.indexOf(movedId);
  if (from === -1) return;
  order.splice(from, 1);
  let to = order.indexOf(targetId);
  if (to === -1) return;
  if (after) to += 1;
  order.splice(to, 0, movedId);

  order.forEach((id, i) => {
    const r = state.lastRoomsList.find((x) => x.id === id);
    if (r) r.pin_position = i;
  });
  renderRooms(state.lastRoomsList);

  try {
    await apiJson('/api/rooms/pins/order', { method: 'POST', body: { order } });
  } catch (err) {
    console.error('reorderPinnedRoom failed:', err);
    // The next authoritative `rooms` broadcast (or a manual refresh) restores
    // the server's order; no local rollback needed for a cosmetic reorder.
  }
}

// Touch-friendly pinned-room reorder: drag is mouse-only (native HTML5 DnD
// doesn't fire from touch), so the kebab's Move up / Move down call this to swap
// a pinned room with its neighbour. Same optimistic reindex + persist as
// reorderPinnedRoom. `dir` is -1 (up) or +1 (down).
async function movePinnedRoom(roomId?: any, dir?: any) {
  const order = state.lastRoomsList
    .filter((r) => r.pinned && !r.archived)
    .sort((a, b) => (a.pin_position ?? 0) - (b.pin_position ?? 0))
    .map((r: any) => r.id);
  const i = order.indexOf(roomId);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  order.forEach((id, k) => {
    const r = state.lastRoomsList.find((x) => x.id === id);
    if (r) r.pin_position = k;
  });
  renderRooms(state.lastRoomsList);
  try {
    await apiJson('/api/rooms/pins/order', { method: 'POST', body: { order } });
  } catch (err) {
    console.error('movePinnedRoom failed:', err);
    // The next authoritative `rooms` broadcast restores order; no rollback needed.
  }
}

async function toggleRoomPin(roomId?: any, pin?: any) {
  // PER-USER pin. Optimistic flip + re-render, same pattern as hide/archive.
  // The server replays authoritative state via broadcastRooms (which also syncs
  // the pin to this user's other devices).
  const target = state.lastRoomsList.find((r) => r.id === roomId);
  if (target) target.pinned = pin;
  renderRooms(state.lastRoomsList);
  try {
    await apiJson(`/api/rooms/${encodeURIComponent(roomId)}/${pin ? 'pin' : 'unpin'}`, { method: 'POST' });
  } catch (err) {
    console.error('toggleRoomPin failed:', err);
    if (target) target.pinned = !pin; // roll back
    renderRooms(state.lastRoomsList);
  }
}

async function toggleRoomHide(roomId?: any, hide?: any) {
  // PER-USER hide. Optimistic flip, same pattern as toggleRoomArchive.
  // Lives on a separate endpoint and table from archive so the two
  // concepts don't conflate.
  const target = state.lastRoomsList.find((r) => r.id === roomId);
  if (target) target.hidden = hide;
  renderRooms(state.lastRoomsList);
  try {
    await apiJson(`/api/rooms/${encodeURIComponent(roomId)}/${hide ? 'hide' : 'unhide'}`, { method: 'POST' });
  } catch (err) {
    console.error('toggleRoomHide failed:', err);
    if (target) target.hidden = !hide; // roll back
    renderRooms(state.lastRoomsList);
  }
}

export function joinRoom(roomId?: any, roomName?: any, jumpMessageId?: any, initialThread?: any) {
  // When set (e.g. from a search-result click), the `history` handler lands on
  // this message instead of scrolling to the bottom.
  state.pendingJumpMessageId = jumpMessageId || null;
  // A queued post-join send belongs to the join that queued it (set AFTER the
  // joinRoom call) — a newer switch must not deliver it into the wrong room.
  state.pendingSendAfterJoin = null;
  closeAgentDetail();
  closeRoomDetail();
  deps.closeModelDetail();
  closeMcpDetail();
  // Opening a room exits any full view (Agents/Models/Topology/Wiring/
  // Permissions/Dashboard) and restores the chat pane as the backdrop —
  // otherwise the room "opens" behind a still-visible full view.
  deps.hideOtherFullViews();
  $('#chat')!.hidden = false;
  // Reset any in-progress turn state from the previous room so its bubbles /
  // elapsed timer / reasoning traces can't leak into the new room.
  endAllAgentTurns();
  const prevRoom = state.currentRoom;
  state.currentRoom = roomId;
  // The active room's thread tree is expanded by default; collapse the room we
  // just left (its chevron re-opens it) so stale trees don't linger open.
  if (prevRoom && prevRoom !== roomId) state.expandedRooms.delete(prevRoom);
  state.expandedRooms.add(roomId);
  state.threadAddRoom = null; // clear any other room's pending inline new-thread input
  state.unreadRooms.delete(roomId);
  state.mentionedRooms.delete(roomId);
  void refreshRoomAutoLearn(roomId);
  updateUnreadDots();
  deps.updateUserCredsBanner(roomId);
  // Set agent name for thinking bubble from the agent wired to this room.
  const roomAgent = (state.allAgents as any[]).find((b: any) => b.room_id === roomId);
  if (roomAgent) state.agentName = roomAgent.name;
  $('#app')!.classList.add('in-room');
  $('#app')!.classList.remove('in-dashboard');
  for (const t of state.typingUsers.values()) clearTimeout((t as any).timeout);
  state.typingUsers.clear();
  deps.renderTypingIndicator();
  $('#members-panel')!.hidden = true;
  $('#members-overlay')!.classList.remove('visible');
  deps.renderMembers([]);
  beginTranscriptSwitch();
  // Land in the regular chat ('main' keys the room's shared session) unless
  // `initialThread` enters a thread directly in a SINGLE join — a separate
  // join('main')+join(thread) races and bleeds main's transcript in.
  state.currentThread = initialThread || 'main';
  // Persist in localStorage (NOT sessionStorage, which iOS wipes when the PWA is
  // fully closed) so reopening resumes the same room AND thread.
  localStorage.setItem('lastThread:' + roomId, state.currentThread);
  state.threadUnread.clear();
  state.threadCache.delete(roomId); // clear this room's cached threads; loadThreadList refills
  updateThreadSyncControls();
  // Only send on an OPEN socket: send() while CONNECTING throws, which would
  // abort the rest of this function (reachable on resume from background).
  // Skipping is safe: ws.ts re-joins state.currentRoom on auth success.
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'join', room_id: roomId, thread_id: state.currentThread }));
  }
  loadThreadList(roomId);
  localStorage.setItem('lastRoom', roomId);
  $('#room-name')!.textContent = `#${roomId}`;
  $<HTMLInputElement>('#message-input')!.disabled = false;
  const learnBtn = ($('#learn-btn')) as HTMLInputElement;
  if (learnBtn) {
    learnBtn.disabled = false;
    learnBtn.hidden = !state.learningMasterEnabled;
  }
  deps.hideLearnNudge(); // a suggestion about one room's turn doesn't follow you around
  learnTurnToolCount.value = 0;
  $<HTMLInputElement>('#message-form button[type=submit]')!.disabled = false;
  showRoomSettingsToggle(true);
  // Re-render the room list so the now-active room gets its nested thread
  // tree container (renderRooms adds .thread-list for the active room, then
  // loadThreadList populates it when its fetch resolves).
  if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
  // Prime the mention-autocomplete caches so the first '@' the user types
  // doesn't have to wait on a fetch.
  refreshWiredAgentsForCurrentRoom();
  deps.fetchMentionablePeople();
}

export function clearRoomSearch() {
  roomFilter.value = '';
  // The island's rows, not its host's HTML (see clearStagedFiles in files.ts).
  searchRows.value = [];
  const list = $('#search-results');
  if (list) list.hidden = true;
  const roomList = $('#room-list');
  if (roomList) roomList.hidden = false;
  const sortBtn = $('#room-sort-az');
  if (sortBtn) sortBtn.hidden = false; // sort icon returns to the search bar's right slot
  const close = $('#room-search-close');
  if (close) close.hidden = true;
}

export async function continueRoomImport(up?: any) {
  const p = up.preview;
  const el = document.createElement('div');
  const line = (t?: any, cls?: any) => {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = t;
    el.appendChild(d);
  };
  line(`${p.manifest.entity.name} → imports as #${p.suggestedRoomId}`);
  line(`${p.manifest.counts.messages} messages · ${p.manifest.counts.threads} threads · ${p.manifest.counts.files} files`);
  const found = p.agents.filter((a: any) => a.found).map((a: any) => a.name);
  const missing = p.agents.filter((a: any) => !a.found).map((a: any) => a.name);
  if (found.length) line(`Re-wires agents: ${found.join(', ')}`);
  if (missing.length) line(`⚠ Agents not on this install (wiring skipped): ${missing.join(', ')}`, 'import-warning');
  const ok = await deps.showConfirmModal({ title: 'Import this room?', body: el, confirmLabel: 'Import' });
  if (!ok) return;
  try {
    const out = await apiJson('/api/rooms/import/apply', { method: 'POST', body: { token: up.token } });
    showToast(`Imported #${out.roomId} — ${out.messages} messages`, { kind: 'success' });
  } catch (err) {
    showToast('Import failed: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

function showRoomSettingsToggle(visible?: any) {
  // The room name itself is the settings affordance (Telegram/WhatsApp pattern);
  // `.has-settings` adds the pointer + chevron and gates the click.
  $('#room-name')!.classList.toggle('has-settings', visible);
}

export async function openRoomDetail(roomId?: any) {
  selectedRoomId.value = roomId;
  closeAgentDetail();
  closeMcpDetail();
  $('#room-create-view')!.hidden = true;
  $('#room-edit-view')!.hidden = false;

  const room = state.lastRoomsList.find((r) => r.id === roomId);
  $('#room-detail-title')!.textContent = room ? `${room.name} — settings` : 'Room settings';

  // Rename field — owner-only (the server also enforces). Prefilled with the
  // current name; saving PUTs /name and the server's broadcastRooms refreshes
  // the sidebar + this panel's title.
  const renameField = $('#room-rename-field')!;
  if (state.isOwnerView && room) {
    renameField.hidden = false;
    $<HTMLInputElement>('#room-rename-input')!.value = room.name || '';
  } else {
    renameField.hidden = true;
  }

  // Archive toggle: server tells us per room whether the caller can
  // archive (owner / admin / scoped-admin-of-wired-agent). Show the
  // button only when allowed; flip label based on current state.
  const archiveBtn = $('#room-archive-toggle')!;
  if (room && room.canArchive) {
    archiveBtn.hidden = false;
    archiveBtn.textContent = room.archived ? 'Unarchive room' : 'Archive room';
  } else {
    archiveBtn.hidden = true;
  }

  await refreshRoomWiredAgents(roomId);

  // UserCreds credential-mode selector — admin/owner only (canArchive implies that).
  const credSection = $('#room-credential-mode-section');
  if (credSection) {
    if (room && room.canArchive) {
      credSection.hidden = false;
      // Clear any prior room's selection FIRST so a failed/mismatched fetch can't
      // leave the previous room's mode showing as this room's policy.
      document
        .querySelectorAll('#room-credential-modes .setting-option')
        .forEach((b) => b.classList.remove('active'));
      const hintEl = $('#room-cred-default-hint');
      if (hintEl) hintEl.textContent = '';
      apiJson(`/api/rooms/${encodeURIComponent(roomId)}/credential-mode`)
        .then((d) => {
          // No explicit override → the room follows the workspace default: highlight
          // that value. An explicit pick highlights itself.
          const effective = d.mode === 'inherit' ? d.defaultMode : d.mode;
          document
            .querySelectorAll('#room-credential-modes .setting-option')
            .forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.value === effective));
          if (hintEl) hintEl.textContent = '';
        })
        .catch(() => {
          if (hintEl) hintEl.textContent = '(couldn’t load — try reopening)';
        });
    } else {
      credSection.hidden = true;
    }
  }

  $('#room-detail')!.hidden = false;
  $('#members-panel')!.hidden = true;
  $('#agent-detail')!.hidden = true;
}

export function closeRoomDetail() {
  $('#room-detail')!.hidden = true;
  $('#room-edit-view')!.hidden = false;
  $('#room-create-view')!.hidden = true;
  selectedRoomId.value = null;
}

// Rename the selected room. Owner-only (the field is hidden otherwise, and the
// server re-checks). The server's broadcastRooms() pushes the new name, so the
// sidebar + panel title update via the 'rooms' handler — no manual refresh.
export async function saveRoomName() {
  const id = selectedRoomId.value;
  if (!id) return;
  const name = $<HTMLInputElement>('#room-rename-input')!.value.trim();
  if (!name) {
    showToast('Enter a room name', { kind: 'error' });
    return;
  }
  try {
    await apiJson(`/api/rooms/${encodeURIComponent(id)}/name`, { method: 'PUT', body: { name } });
    showToast('Room renamed', { kind: 'success' });
  } catch (err) {
    showToast('Rename failed: ' + ((err as any)?.message || err), { kind: 'error' });
  }
}

export async function deleteCurrentRoom() {
  if (!selectedRoomId.value) return;
  const room = state.lastRoomsList.find((r) => r.id === selectedRoomId.value);
  const label = room ? room.name : selectedRoomId.value;
  const confirmed = await deps.showConfirmModal({
    title: 'Delete room',
    body: `Delete room "${label}"? Wired agents will be preserved — delete them separately if you want them gone.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!confirmed) return;
  const roomToClose = selectedRoomId.value;
  try {
    await apiJson(`/api/rooms/${encodeURIComponent(roomToClose)}`, { method: 'DELETE' });
    showToast(`Deleted room "${label}".`, { kind: 'success' });
    closeRoomDetail();
    if (state.currentRoom === roomToClose) {
      state.currentRoom = null;
      $('#room-name')!.textContent = 'Select a room';
      $<HTMLInputElement>('#message-input')!.disabled = true;
      $<HTMLInputElement>('#message-form button[type=submit]')!.disabled = true;
      transcriptEmpty.value = 'Select a room from the sidebar to start chatting';
      showRoomSettingsToggle(false);
    }
  } catch (err) {
    showToast('Failed to delete room: ' + (err as any)?.message, { kind: 'error' });
  }
}

export function toggleRoomSettings() {
  if (!state.currentRoom) return;
  if (selectedRoomId.value === state.currentRoom && !$('#room-detail')!.hidden) closeRoomDetail();
  else openRoomDetail(state.currentRoom);
}

export async function openRoomCreate() {
  selectedRoomId.value = null;
  closeAgentDetail();
  $('#room-edit-view')!.hidden = true;
  $('#room-create-view')!.hidden = false;
  $<HTMLInputElement>('#room-create-name')!.value = '';
  $<HTMLInputElement>('#room-create-new-name')!.value = '';
  $<HTMLInputElement>('#room-create-new-instructions')!.value = '';
  $('#room-create-new-block')!.hidden = true;
  await fetchAgents();
  renderRoomCreateAgentChecklist();
  $('#room-detail')!.hidden = false;
  $('#members-panel')!.hidden = true;
  $('#agent-detail')!.hidden = true;
  $('#room-create-name')!.focus();
}

async function refreshRoomAutoLearn(roomId?: any) {
  try {
    const cfg = await apiJson(`/api/rooms/${encodeURIComponent(roomId)}/learning`);
    roomAutoLearn.set(roomId, cfg.autoTrigger === true);
  } catch {
    /* keep whatever we knew */
  }
}

export async function putRoomLearning(patch?: any) {
  try {
    await apiJson(`/api/rooms/${encodeURIComponent(state.currentRoom!)}/learning`, { method: 'PUT', body: patch });
    showToast('Learning settings saved for this room');
    void refreshRoomAutoLearn(state.currentRoom);
    return true;
  } catch (err) {
    toastError(err, 'Could not save');
    return false;
  }
}

// The room-search debounce timer lives at MODULE scope, not inside the wiring
// function: it holds state across separate input events, so nesting it would
// start a fresh timer per call and debounce nothing.
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

let searchResultsApp: ReturnType<typeof createApp> | null = null;

function mountSearchResults(): void {
  searchResultsApp ??= mountIsland('#search-results', () => createApp(SearchResults));
}

function renderSearchResults(results: any[]): void {
  const list = $('#search-results');
  if (!list) return;
  mountSearchResults();
  searchRows.value = (results || []).map((r: any) => ({
    id: String(r.id),
    roomId: String(r.roomId),
    roomName: String(r.roomName),
    time: relativeTime(r.createdAt),
    // Escape FIRST, then turn the FTS5 «…» markers into <mark>. That order is
    // the XSS guarantee, so it stays here rather than in the component — which
    // receives the finished line and may not build it.
    snipHtml:
      `<span class="search-result-sender">${esc(r.sender)}:</span> ` +
      esc(r.snippet || '')
        .replace(/«/g, '<mark>')
        .replace(/»/g, '</mark>'),
  }));
  list.hidden = false;
  // The room list STAYS, filtered to the same query: one box, two answers.
  const sortBtn = $('#room-sort-az');
  if (sortBtn) sortBtn.hidden = true; // close button takes the slot while searching
}

function relativeTime(ts: number | string) {
  const diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
  if (diff < 0 || diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ── Panel wiring ─────────────────────────────────────────────────────────────
// The room list and room detail panel: drag-to-reorder, create, archive and
// the wired-agents controls.
// Called from composition-root.ts at its place in boot order rather than run at module scope (check-boot-order.sh).

export function wireRoomsPanel(): void {
  $<HTMLInputElement>('#room-search')?.addEventListener('input', (e) => {
    const q = (e.target as HTMLInputElement).value.trim();
    // Narrow the room list on THIS keystroke; names are already in memory, so
    // only the message search waits for the debounce.
    roomFilter.value = q;
    // Show the close/back affordance whenever a query is active (immediate, not
    // debounced) so the dismissal control is there the moment search begins.
    const closeBtn = $<HTMLButtonElement>('#room-search-close');
    if (closeBtn) closeBtn.hidden = !q;
    clearTimeout(searchDebounce);
    if (!q) {
      clearRoomSearch();
      return;
    }
    searchDebounce = setTimeout(async () => {
      try {
        // A backend without the route yet throws into the empty render below.
        const body = await apiJson(`/api/search?q=${encodeURIComponent(q)}`);
        renderSearchResults(body.results || []);
      } catch {
        renderSearchResults([]);
      }
    }, 250);
  });

  // Close/back button: mobile has no Escape key and the native search clear is
  // unreliable, so this is the tap target back to the room list.
  $<HTMLButtonElement>('#room-search-close')?.addEventListener('click', () => {
    const input = $<HTMLInputElement>('#room-search');
    if (input) input.value = '';
    clearRoomSearch();
    if (input) input.blur();
  });

  $('#search-results')?.addEventListener('click', (e) => {
    const li = (e.target as Element | null)?.closest<HTMLElement>('.search-result');
    if (!li) return;
    const { roomId, roomName, messageId } = li.dataset;
    // Keep the search pane open so you can jump through several hits in a row.
    // Mark the one you're viewing; close via Escape or by clearing the search box.
    $('#search-results .search-result.active')?.classList.remove('active');
    li.classList.add('active');
    joinRoom(roomId, roomName, messageId);
  });

  // Escape closes the search pane (DESIGN §3 dismissal contract — same key that
  // closes settings / lightbox / modals). Clearing the box also closes it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const list = $('#search-results');
    if (!list || list.hidden) return;
    const input = $<HTMLInputElement>('#room-search');
    if (input) input.value = '';
    clearRoomSearch();
  });

  $('#room-name')?.addEventListener('click', toggleRoomSettings);
}

// ── Panel wiring ───────────────────────────────────────────────────────────
// Remaining room-detail wiring: prime, archive and the wired-agent controls.
// One function per run of boot statements: a call cannot span an executing statement without reordering boot.

export function wireRoomDetail1(): void {
  $('#room-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleRoomSettings();
    }
  });
}

export function wireRoomDetail2(): void {
  $('#room-credential-modes')?.addEventListener('click', async (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLElement>('.setting-option');
    if (!btn || !selectedRoomId.value) return;
    const mode = btn.dataset.value; // disabled | optional | required (explicit override)
    const r = await authFetch(`/api/rooms/${encodeURIComponent(selectedRoomId.value)}/credential-mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ mode }),
    });
    if (r.ok) {
      document
        .querySelectorAll<HTMLElement>('#room-credential-modes .setting-option')
        .forEach((b) => b.classList.toggle('active', b === btn));
      // Picking a pill sets an explicit override, so it's no longer inheriting.
      const hintEl = $('#room-cred-default-hint');
      if (hintEl) hintEl.textContent = '';
      const label = ({ disabled: 'off', optional: 'optional', required: 'required' } as Record<string, string>)[mode ?? ''] ?? mode;
      showToast(`User credentials: ${label}.`, { kind: 'success' });
      if (selectedRoomId.value === state.currentRoom) updateUserCredsBanner(state.currentRoom);
    } else {
      const err = await r.json().catch(() => ({}));
      showToast('Failed to set mode: ' + (err.error || r.statusText), { kind: 'error' });
    }
  });
}

export function wireRoomDetail3(): void {
  $<HTMLInputElement>('#room-rename-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRoomName();
    }
  });
  $<HTMLButtonElement>('#room-archive-toggle')?.addEventListener('click', async () => {
    if (!selectedRoomId.value) return;
    const room = state.lastRoomsList.find((r) => r.id === selectedRoomId.value);
    if (!room) return;
    await toggleRoomArchive(selectedRoomId.value, !room.archived);
    // Refresh the panel so the button label flips.
    if (!$('#room-detail')?.hidden) openRoomDetail(selectedRoomId.value);
  });
}

export function wireRoomDetail4(): void {
  $<HTMLButtonElement>('#archived-toggle')?.addEventListener('click', () => {
    showArchived.value = !showArchived.value;
    sessionStorage.setItem('webchat:showArchived', showArchived.value ? '1' : '0');
    if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
  });
  $<HTMLButtonElement>('#hidden-toggle')?.addEventListener('click', () => {
    showHidden.value = !showHidden.value;
    sessionStorage.setItem('webchat:showHidden', showHidden.value ? '1' : '0');
    if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
  });
}

export function wireRoomDetail5(): void {
  $<HTMLButtonElement>('#room-create-toggle-new')?.addEventListener('click', () => {
    const newBlock = $('#room-create-new-block');
    if (!newBlock) return;
    newBlock.hidden = !newBlock.hidden;
    if (!newBlock.hidden) $<HTMLInputElement>('#room-create-new-name')?.focus();
  });
}

/** The room-create form: name, instructions and agent selection. */
export function wireRoomCreate(): void {
  $<HTMLFormElement>('#room-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = ($<HTMLInputElement>('#room-create-name')?.value ?? '').trim();
    if (!name) return;
    // the picker holds checkboxes; refs is heterogeneous (existing | new)
    const boxes = $('#room-create-existing-agents')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    const checked: Array<Record<string, unknown>> = Array.from(boxes ?? [])
      .filter((cb) => cb.checked)
      .map((cb) => ({ kind: 'existing', id: cb.value }));
    const newName = ($<HTMLInputElement>('#room-create-new-name')?.value ?? '').trim();
    const refs: Array<Record<string, unknown>> = [...checked];
    if (newName) {
      refs.push({
        kind: 'new',
        name: newName,
        instructions: ($<HTMLTextAreaElement>('#room-create-new-instructions')?.value ?? '') || undefined,
      });
    }
    if (refs.length === 0) {
      showToast('Pick at least one existing agent or create a new one inline.', { kind: 'error' });
      return;
    }
    try {
      const body = await apiJson('/api/rooms', { method: 'POST', body: { name, agents: refs } });
      closeRoomDetail();
      await fetchAgents();
      // The broadcastRooms() server-side will push the updated list via WS,
      // but join immediately so the user lands in the new room.
      if (body.room) joinRoom(body.room.id, body.room.name);
    } catch (err: any) {
      showToast('Failed to create room: ' + err.message, { kind: 'error' });
    }
  });
}

export function updateUnreadDots() {
  if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
}

// ── Room ordering ─────────────────────────────────────────────────────────
// Live last-activity overrides keyed by room id. The rooms payload carries a
// server-computed `last_activity`; as messages arrive while the app is open we
// bump this map so the active room floats to the top without a server round-trip.
export function activityOf(room: any) {
  return Math.max(room.last_activity || room.created_at || 0, state.roomActivity.get(room.id) || 0);
}
