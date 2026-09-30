// ── Composer ─────────────────────────────────────────────────────────────────
// The message composer: send, the @-mention autocomplete, and the typing
// indicator round-trip.
import { $, esc } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { pendingFiles } from './attach-picker-state.js';
import { showToast } from '../core/toast.js';
import { apiJson } from '../core/api.js';
import { isAdminView, state } from '../core/state.js';
import { dismissMentionPopover, renderMentionPopover, showConfirmModal } from './modals.js';
import { ensureTurn, removeTurn } from './thinking.js';
import { thinkingTurns } from './transcript-state.js';
import { appendMessage, clearUserScrollMarkers, scrollToBottom } from './transcript.js';
import { clearStagedFiles, uploadFile } from './files.js';
import { createApp } from 'vue';
import SlashMenu from './SlashMenu.vue';
import { slashActiveIndex, slashRows } from './slash-menu-state.js';

let roomMentionPeople: any[] = []; // current room's human members as @ autocomplete candidates

// People you can @-mention here: anyone with a handle who can access the room,
// online or not (mentions notify on return) — so sourced from the server, NOT
// the connected-members list.
export async function fetchMentionablePeople() {
  const roomId = state.currentRoom;
  if (!roomId) {
    roomMentionPeople = [];
    return;
  }
  try {
    // Throws on error: leave stale rather than blanking.
    const people = await apiJson(`/api/rooms/${encodeURIComponent(roomId ?? "")}/mentionable`);
    if (state.currentRoom === roomId) {
      roomMentionPeople = people.map((p: any) => ({ folder: p.handle, name: p.name, isUser: true }));
    }
  } catch {
    // network blip — leave stale cache
  }
}

export function tryActivateMention(input: any) {
  // Candidates: wired agents (trigger the agent) + human members with handles
  // (notify/surface only). De-dup by folder so a handle that collides with an
  // agent folder doesn't double-list.
  const seen = new Set();
  const mentionPool = [];
  for (const a of [...getWiredAgentsForCurrentRoom(), ...roomMentionPeople]) {
    const key = (a.folder || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    mentionPool.push(a);
  }
  if (mentionPool.length === 0) {
    dismissMentionPopover();
    return;
  }
  const value = input.value;
  const cursor = input.selectionStart ?? value.length;
  // Walk back from cursor to find the most recent '@' that's at a word boundary
  // (start of string or preceded by whitespace). Bail if we hit a non-slug char
  // first — that means the cursor is no longer inside a mention token.
  let i = cursor - 1;
  while (i >= 0) {
    const c = value[i];
    if (c === '@') {
      if (i !== 0 && !/\s/.test(value[i - 1])) {
        dismissMentionPopover();
        return;
      }
      break;
    }
    if (!/[a-zA-Z0-9-]/.test(c)) {
      dismissMentionPopover();
      return;
    }
    i--;
  }
  if (i < 0) {
    dismissMentionPopover();
    return;
  }
  setMentionStart(i);
  const token = value.slice(i + 1, cursor).toLowerCase();
  setMentionMatches(mentionPool.filter((a: any) => a.folder.toLowerCase().startsWith(token)).slice(0, 8));
  setMentionSelectedIndex(0);
  if (getMentionMatches().length === 0) {
    dismissMentionPopover();
    return;
  }
  renderMentionPopover(input);
}

export function acceptMention(input: any) {
  if (getMentionStart() < 0 || getMentionMatches().length === 0) return;
  const agent = getMentionMatches()[getMentionSelectedIndex()];
  if (!agent) return;
  const before = input.value.slice(0, getMentionStart());
  const after = input.value.slice(input.selectionStart ?? input.value.length);
  const inserted = `@${agent.folder} `;
  input.value = before + inserted + after;
  const newCursor = before.length + inserted.length;
  input.setSelectionRange(newCursor, newCursor);
  dismissMentionPopover();
  // Fire input so the textarea auto-resize logic (if any) catches up.
  input.dispatchEvent(new Event('input'));
}

// ── Typing indicators ─────────────────────────────────────────────────────
export function handleTypingEvent(msg: any) {
  if (msg.room_id !== state.currentRoom) return;
  const { identity, identity_type, is_typing } = msg;

  if (is_typing) {
    if (identity_type === 'agent') state.agentName = identity;
    if (state.typingUsers.has(identity)) clearTimeout((state.typingUsers.get(identity) as any).timeout);
    const timeout = setTimeout(
      () => {
        state.typingUsers.delete(identity);
        renderTypingIndicator();
      },
      identity_type === 'agent' ? 120000 : 5000,
    );
    state.typingUsers.set(identity, { timeout, identity_type });
  } else {
    if (state.typingUsers.has(identity)) clearTimeout((state.typingUsers.get(identity) as any).timeout);
    state.typingUsers.delete(identity);
  }
  renderTypingIndicator();
}

export function renderTypingIndicator() {
  const el = $('#typing-indicator')!;
  const entries = [...state.typingUsers.entries()];
  const userTypers = entries.filter(([, v]: [string, any]) => v.identity_type !== 'agent');
  const typingAgents = entries.filter(([, v]: [string, any]) => v.identity_type === 'agent').map(([n]) => n);

  // A thinking bubble persists while EITHER a status turn owns it (statusLive,
  // cleared on 'done') OR typing says that agent is working (pre-status warm
  // containers), so a quiet typing stretch never drops a live turn's bubble.
  for (const name of typingAgents) ensureTurn(name);
  for (const t of [...thinkingTurns.value]) {
    if (t.statusLive) continue;
    if (typingAgents.includes(t.name)) continue;
    removeTurn(t.name);
  }

  if (userTypers.length > 0) {
    // esc() each name: display names are IdP/tailnet/proxy-supplied (NOT the
    // validated handle) and this is an innerHTML sink.
    const names = userTypers.map(([n]) => esc(n));
    const label =
      names.length === 1
        ? `${names[0]} is typing`
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing`;
    el.innerHTML = `${label}<span class="dots"><span></span><span></span><span></span></span>`;
    el.className = 'typing-indicator is-visible';
    el.removeAttribute('aria-hidden');
  } else {
    el.classList.remove('is-visible');
    el.setAttribute('aria-hidden', 'true');
  }
}

// ── Slash-command menu ───────────────────────────────────────────────────────
// The /-command autocomplete under the composer. The agent-runner handles these
// commands itself, so this is pure discoverability. Per-session: it acts on the
// session you're in, not background a2a sessions (see the agent's Sessions panel).
const SLASH_COMMANDS = [
  { cmd: '/clear', desc: 'Reset this session — drop context, start fresh' },
  { cmd: '/clear all', desc: "Reset ALL of this agent's sessions (incl. background a2a)" },
  { cmd: '/compact', desc: 'Compact the context now' },
  { cmd: '/compact all', desc: "Compact ALL of this agent's sessions" },
  { cmd: '/context', desc: 'Show context-window usage' },
  { cmd: '/cost', desc: 'Show token cost so far' },
  { cmd: '/files', desc: 'List files in the workspace' },
  { cmd: '/learn', desc: 'Distill a reusable skill from this session' },
];
// The bulk "… all" commands fan out host-side to every session of the room's
// agent(s); they're intercepted on send rather than delivered as chat.
export const BULK_COMMANDS: Record<string, string> = { '/clear all': '/clear', '/compact all': '/compact' };
let slashMatches: Array<{ cmd: string; desc?: string }> = [];
let slashActive = 0;

let slashApp: ReturnType<typeof createApp> | null = null;

function mountSlashMenu(): void {
  slashApp ??= mountIsland('#slash-menu', () => createApp(SlashMenu, { onPick: (i: number) => pickSlash(i) }));
}

export function updateSlashMenu() {
  const menu = $('#slash-menu');
  if (!menu) return;
  // These commands are all admin-only (see command-gate.ts) — don't surface
  // them to non-admins, who'd only get "Permission denied".
  if (!isAdminView.value) {
    slashMatches = [];
    menu.hidden = true;
    return;
  }
  const input = $<HTMLTextAreaElement>('#message-input');
  if (!input) return;
  const v = input.value;
  // Match while typing a command, incl. the "/clear all" form (one trailing word).
  const m = /^\/[a-z-]*( [a-z-]*)?$/i.exec(v);
  slashMatches = m ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(v.toLowerCase())) : [];
  if (slashMatches.length === 0) {
    menu.hidden = true;
    return;
  }
  if (slashActive >= slashMatches.length) slashActive = 0;
  slashRows.value = slashMatches;
  slashActiveIndex.value = slashActive;
  mountSlashMenu();
  menu.hidden = false;
}

function pickSlash(i: number): void {
  const c = slashMatches[i];
  if (!c) return;
  const input = $<HTMLTextAreaElement>('#message-input');
  if (!input) return;
  slashMatches = [];
  const slashMenu = $('#slash-menu');
  if (slashMenu) slashMenu.hidden = true;
  // Bulk "… all" commands are actions, not text — fire them straight away
  // instead of dropping them in the composer to be sent. Defer past this
  // keypress so the confirm modal doesn't catch the same Enter and auto-confirm.
  const bulk = BULK_COMMANDS[c.cmd];
  if (bulk) {
    input.value = '';
    input.style.height = 'auto';
    setTimeout(() => broadcastSessionCommand(bulk), 0);
    return;
  }
  input.value = c.cmd + ' ';
  input.focus();
}

// Returns true if it consumed the key (caller should stop).
export function slashKeydown(e: KeyboardEvent): boolean {
  if (slashMatches.length === 0) return false;
  if (e.key === 'ArrowDown') {
    slashActive = (slashActive + 1) % slashMatches.length;
    updateSlashMenu();
    e.preventDefault();
    return true;
  }
  if (e.key === 'ArrowUp') {
    slashActive = (slashActive - 1 + slashMatches.length) % slashMatches.length;
    updateSlashMenu();
    e.preventDefault();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    pickSlash(slashActive);
    e.preventDefault();
    return true;
  }
  if (e.key === 'Escape') {
    slashMatches = [];
    const slashMenu = $('#slash-menu');
    if (slashMenu) slashMenu.hidden = true;
    e.preventDefault();
    return true;
  }
  return false;
}

// ── Send path and mentions ───────────────────────────────────────────────────
// The send path (client message ids, the outbound send, bulk session commands)
// and the @-mention menu. Other modules read the mention state through the
// accessors below, relayed by composition-root.ts.

let clientMsgSeq = 0;

export function sendCurrentMessage() {
  const input = $<HTMLTextAreaElement>('#message-input');
  if (!input) return;
  const text = input.value.trimEnd(); // trimEnd not trim — preserves leading indentation
  if (!state.currentRoom) return;

  // Files + optional caption (caption attaches to the first upload)
  if (pendingFiles.value.length > 0) {
    const files = pendingFiles.value.map((p: any) => p.file);
    const caption = text;
    clearStagedFiles();
    input.value = '';
    input.style.height = 'auto';
    (async () => {
      for (let i = 0; i < files.length; i++) {
        await uploadFile(files[i], i === 0 ? caption : '');
      }
    })();
    return;
  }

  if (!text) return;
  // Bulk "/clear all" / "/compact all" fan out host-side to every session of
  // the room's agent(s) — intercepted here, not delivered as a chat message.
  const bulk = BULK_COMMANDS[text.toLowerCase()];
  if (bulk) {
    input.value = '';
    input.style.height = 'auto';
    const sm = $('#slash-menu');
    if (sm) sm.hidden = true;
    setTimeout(() => broadcastSessionCommand(bulk), 0);
    return;
  }
  // ws.send on a CONNECTING/CLOSING socket throws or silently drops; bail and
  // keep the input so the user can resend once reconnected.
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('Not connected — try again in a moment.', { kind: 'error' });
    return;
  }
  const clientId = `local-${++clientMsgSeq}-${Date.now()}`;
  state.ws.send(JSON.stringify({ type: 'message', content: text, client_id: clientId, thread_id: state.currentThread }));
  // The optimistic echo hands the WS layer a ROW, not a DOM node: the echo
  // upgrades it in place (status ✓→✓✓, the server id, the delete button).
  const row = appendMessage({ sender: state.myIdentity, sender_type: 'user', content: text }, '✓');
  if (row) {
    // Stamp where this was sent. The history handler carries still-pending rows
    // across its list wipe, and without this it could not tell a row sent HERE
    // from one sent in a room the user has since left.
    row.roomId = state.currentRoom;
    row.threadId = state.currentThread;
    state.pendingMessages.set(clientId, row);
  }
  state.userScrolledAway = false;
  state.forceScrollCount = 3; // ensure agent response scrolls into view
  // Clear input markers so the smooth scroll below isn't mistaken for
  // user-driven by a stale wheel/touch immediately before send.
  clearUserScrollMarkers();
  scrollToBottom();
  input.value = '';
  input.style.height = 'auto';
}

// Fan a bulk command (/clear or /compact) out to every active session of the
// room's agent(s) — the "… all" slash commands. The server resolves the room's
// wired agents and enforces admin (incl. their background a2a sessions).
export async function broadcastSessionCommand(command: string): Promise<void> {
  if (!state.currentRoom) return;
  const verb = command === '/clear' ? 'Reset' : 'Compact';
  const ok = await showConfirmModal({
    title: `${verb} all sessions`,
    body: `${verb} every active session of this room's agent(s) — including background agent-to-agent sessions${command === '/clear' ? '. Each drops its context and starts fresh on the next turn.' : '.'}`,
    confirmLabel: verb,
    destructive: command === '/clear',
  });
  if (!ok) return;
  try {
    const body = await apiJson(`/api/rooms/${encodeURIComponent(state.currentRoom)}/sessions/broadcast`, {
      method: 'POST',
      body: { command },
    });
    showToast(`${verb} queued for ${body.count} session(s)`, { kind: 'success' });
  } catch (err: any) {
    showToast(`${verb} all failed: ${err.message}`, { kind: 'error' });
  }
}

// ── Mention autocomplete (@<folder>) + chip rendering ─────────────────────────
// Purely UX: the router engages on the agent's engage_pattern (`\B@<folder>\b`,
// see ciFolderToken in server/agent-wiring.ts). The cache refreshes on join and
// on broadcastRooms, so wiring changes stay current without polling.

let wiredAgentsForCurrentRoom: any[] = []; // [{ id, name, folder, is_prime }]

let mentionStart = -1;
let mentionMatches: any[] = [];
let mentionSelectedIndex = 0;

/** The composer's own wiring: form submit, keydown, and the mention menu. */
export function wireComposer(): void {
  $<HTMLFormElement>('#message-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    sendCurrentMessage();
  });
  $<HTMLTextAreaElement>('#message-input')?.addEventListener('keydown', (e) => {
    // Slash-command menu (when open) consumes nav/select/dismiss keys first.
    if (slashKeydown(e)) return;

    // If mention popover is showing, let it consume Enter/Tab before send fires.
    if (mentionMatches.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) return;
    if (e.key !== 'Enter') return;
    if (state.settings?.sendKey === 'enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      sendCurrentMessage();
    }
    if (state.settings?.sendKey === 'shift-enter' && e.shiftKey) {
      e.preventDefault();
      sendCurrentMessage();
    }
    if (state.settings?.sendKey === 'ctrl-enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendCurrentMessage();
    }
  });
    const input = $<HTMLTextAreaElement>('#message-input');
    if (!input) return;
    input.addEventListener('input', () => tryActivateMention(input));
    input.addEventListener('blur', () => {
      // Defer so a click on a popover item registers before we tear down.
      setTimeout(dismissMentionPopover, 120);
    });

    // Capture phase so we intercept Enter/Tab before the send-message handler
    // fires. Only intercept when the popover is actually showing.
    input.addEventListener(
      'keydown',
      (e) => {
        if (mentionMatches.length === 0) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionMatches.length;
          renderMentionPopover(input);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionMatches.length) % mentionMatches.length;
          renderMentionPopover(input);
        } else if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          acceptMention(input);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          dismissMentionPopover();
        }
      },
      true,
    );
}

export function getWiredAgentsForCurrentRoom(): any[] {
  return wiredAgentsForCurrentRoom;
}

export function setWiredAgentsForCurrentRoom(v: any[]): void {
  wiredAgentsForCurrentRoom = v;
}

export function getMentionStart(): number {
  return mentionStart;
}

export function setMentionStart(v: number): void {
  mentionStart = v;
}

export function getMentionMatches(): any[] {
  return mentionMatches;
}

export function setMentionMatches(v: any[]): void {
  mentionMatches = v;
}

export function getMentionSelectedIndex(): number {
  return mentionSelectedIndex;
}

export function setMentionSelectedIndex(v: number): void {
  mentionSelectedIndex = v;
}
