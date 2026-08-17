// ── WebSocket transport ──────────────────────────────────────────────────────
// The socket lifecycle and the message dispatcher: open/close/retry with
// backoff, and the switch that turns every server event into a transcript,
// room-list, thread, approval or status update. Also the connection banner and
// the diagnose-on-failure probe.
//
// Extracted LAST of the phase-1 core, on purpose. Measured against connect():
//
//   56 external names  before features/transcript existed
//   43                 after transcript
//   17                 after core/state
//
// Pulling it out first would have meant inventing ~40 injected accessors for
// things that simply became imports once their real owners existed. The order
// was chosen from those numbers, not from taste.
import { $, lucide, lucideEl, esc } from '../core/dom.js';
import { learnTurnToolCount, roomAutoLearn } from '../features/room-list-state.js';
import { pushReasoning, setThinkingMilestone, updateThinkingBubble } from '../features/thinking.js';
import { renderCredentialIsolation } from '../features/settings.js';
import { isAdminView } from './state.js';
import { permsMyUserId } from '../features/perms-list-state.js';
import { joinRoom, renderRooms, updateUnreadDots } from '../features/rooms.js';
import { renderHandleChip, renderMembers, userIsOwner } from '../features/members.js';
import { hideLearnNudge, showLearnNudge, triggerLearn } from '../features/learn.js';
import { fetchMentionablePeople, handleTypingEvent } from '../features/composer.js';
import { beginAgentTurn, endAgentTurn, interruptAgent, markTurnActivity, refreshWiredAgentsForCurrentRoom } from '../features/agents.js';
import { showToast, toastError } from '../core/toast.js';
import { authFetch, apiJson, getWsUrl, getWsProtocols } from '../core/api.js';
import { state } from '../core/state.js';
import { readdRow, transcriptEmpty, type MsgRow } from '../features/transcript-state.js';
import {
  appendMessage, appendSystem, isNearBottom, scrollToBottom, setMessages,
  scheduleFollowScroll, updateScrollButton, incrementMissedMessages,
  messageMentionsMe, jumpToMessage, beginTranscriptSwitch, endTranscriptSwitch,
} from '../features/transcript.js';
import { fetchApprovals, handleApprovalEvent, handleApprovalResolvedEvent } from '../features/approvals.js';
import { handleSkillDraftReview, refreshDraftBadge, unmountAllDraftCards } from '../features/skills.js';

/**
 * What core/ws needs from legacy. Declaring this as a TYPE rather than an
 * untyped bag is most of the value of converting this file: `const deps = {}`
 * infers `{}`, so every `deps.x(...)` was an error the moment strict checking
 * applied — 25 of the 45 errors this conversion started with.
 *
 * It also documents the contract in one place. check:deps still earns its
 * keep: types cannot see whether legacy.js actually SUPPLIES these at runtime,
 * only that the shapes agree.
 */
/**
 * The socket, plus the one marker we hang on it. `_intentionalClose` tells the
 * close handler that WE closed the socket (reconnect, logout) so it must not
 * schedule a retry. Declaring it beats casting at each of the three use sites.
 */
export interface TaggedSocket extends WebSocket {
  _intentionalClose?: boolean;
}

export interface WsDeps {
}

const deps = {} as WsDeps;

/** Wire the legacy helpers the dispatcher calls. Call once at startup. */
export function provideWsDeps(provided: Partial<WsDeps>): void {
  Object.assign(deps, provided);
}

export function setConnectionBanner(text: string, offerOpenTailscale = false): void {
  const banner = $('#connection-banner');
  if (!banner) return; // markup guarantees it; a no-op beats a throw
  banner!.replaceChildren(document.createTextNode(text));
  // Best-effort app-scheme hop, mobile only — desktop has no tailscale://
  // handler and the tray UI is one click away anyway.
  if (offerOpenTailscale && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'banner-action';
    btn.textContent = 'Open Tailscale';
    btn.addEventListener('click', () => {
      location.href = 'tailscale://';
    });
    banner!.appendChild(btn);
  }
  banner!.classList.add('visible');
}

export async function diagnoseConnection() {
  if (!navigator.onLine) {
    setConnectionBanner('You’re offline. Reconnecting when the network returns…');
    return;
  }
  if (Date.now() - state.lastProbeAt < 10000) {
    // Throttled — but each retry's onclose resets the banner to the generic
    // text, so re-apply the standing diagnosis instead of losing it.
    if (state.lastDiagnosis) setConnectionBanner(state.lastDiagnosis.text, state.lastDiagnosis.offer);
    return;
  }
  state.lastProbeAt = Date.now();
  const internetUp = await probeInternet();
  // The socket may have recovered while the probe ran — never overwrite a
  // hidden banner.
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
  state.lastDiagnosis = internetUp
    ? {
        text: state.serverUsesTailscale
          ? 'Internet is up but the server is unreachable — check that Tailscale is connected on this device.'
          : 'Internet is up but the server is unreachable — it may be down.',
        offer: state.serverUsesTailscale,
      }
    : { text: 'No internet connection. Reconnecting…', offer: false };
  setConnectionBanner(state.lastDiagnosis.text, state.lastDiagnosis.offer);
}

export function connect() {
  // Close any existing socket cleanly before opening a new one. The
  // intentional-close flag lives ON the socket so two rapid reconnects
  // don't collapse into one — the OLD socket's onclose checks the OLD
  // socket's flag, while the new socket runs independently.
  if (state.ws) {
    (state.ws as TaggedSocket)._intentionalClose = true;
    try {
      state.ws.close();
    } catch {}
  }
  const sock = new WebSocket(getWsUrl(), getWsProtocols());
  state.ws = sock;

  sock.onopen = () => {
    $('#connection-banner')?.classList.remove('visible');
    state.reconnectDelay = 1000;
    state.lastProbeAt = 0; // next drop diagnoses fresh, not against a stale probe
    state.lastDiagnosis = null;
    sock.send(JSON.stringify({ type: 'auth' }));
  };

  sock.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
      case 'system':
        if (msg.message && !state.myIdentity) {
          const m = msg.message.match(/^(?:Connected as|Welcome,)\s+(.+)$/);
          if (m) state.myIdentity = m[1].trim();
        }
        appendSystem(msg.message);
        return;
      case 'rooms':
        if (!state.lastRoomsList.length && msg.rooms.length) void refreshDraftBadge();
        state.lastRoomsList = msg.rooms;
        // Seed persistent unread badges from the server's per-user read markers
        // so messages that arrived while away surface on reconnect — not just
        // live ones. Never dot the open room (the join that follows reads it).
        msg.rooms.forEach((r: any) => {
          if (r.unread && r.id !== state.currentRoom) state.unreadRooms.add(r.id);
          if (r.mention && r.id !== state.currentRoom) state.mentionedRooms.add(r.id);
          else if (!r.mention) state.mentionedRooms.delete(r.id);
          else state.unreadRooms.delete(r.id);
        });
        // Render rooms immediately from the WS payload — renderRooms doesn't use
        // allAgents, so don't block first paint on the /api/agents round-trip
        // (it reset per page load, delaying every load by a round-trip). Load
        // agents in parallel for the later consumers that do need them (which
        // already lazy-load via fetchAgents() when the list is empty).
        renderRooms(msg.rooms);
        if (state.allAgents.length === 0) {
          authFetch('/api/agents')
            .then((r) => r.json())
            .then((b) => {
              state.allAgents = b;
            })
            .catch(() => {});
        }
        // Catch up on approvals queued while offline / mid-reconnect. Idempotent.
        fetchApprovals();
        // (Re)load my @-mention handle so self-highlight/notify work this session.
        fetchMyHandle();
        // Reveal the Permissions header button if the caller is owner.
        // Idempotent: probe runs every reconnect, but the button only
        // toggles visible.
        probeIsOwner();
        // Wirings or prime designations may have changed — refresh the
        // mention-autocomplete caches for the active room.
        refreshWiredAgentsForCurrentRoom();
        fetchMentionablePeople();
        if (state.currentRoom) {
          // Rejoin after reconnect — catch up on missed messages
          state.ws?.send(JSON.stringify({ type: 'join', room_id: state.currentRoom }));
          if (state.lastSeenMessageId) {
            authFetch(`/api/rooms/${state.currentRoom}/messages?after_id=${state.lastSeenMessageId}`)
              .then((r) => r.json())
              .then((missed) => {
                if (missed.length > 0) {
                  // Capture before append: if the user was scrolled up reading
                  // history when the WS dropped, don't yank them down on reconnect.
                  const wasNearBottom = isNearBottom();
                  missed.forEach((m: any) => appendMessage(m));
                  setLastSeenMessageId(missed[missed.length - 1].id);
                  if (wasNearBottom) scrollToBottom();
                  else updateScrollButton();
                }
              })
              .catch(() => {});
          }
        } else {
          const saved = localStorage.getItem('lastRoom');
          if (saved) {
            const room = msg.rooms.find((r: any) => r.id === saved);
            if (room) {
              // Resume the exact thread too (not just the room), so a thread you
              // were in survives a full PWA close/reopen.
              const savedThread = localStorage.getItem('lastThread:' + saved);
              joinRoom(room.id, room.name, undefined, savedThread && savedThread !== 'main' ? savedThread : undefined);
            }
          }
        }
        break;
      case 'history': {
        // Draft cards are rows in the list now, not per-instance apps mounted
        // into elements here, so replacing the list disposes them with it —
        // there is nothing left to unmount by hand.
        // A message sent between the join and THIS reply is not in the payload —
        // the server queried before it existed — so wiping the list drops it for
        // good: the echo UPGRADES a row in place, and a row that is no longer in
        // the list can never be re-added by it. The message then stayed
        // invisible until the next room switch re-fetched history. That is the
        // "my first message didn't show up" bug, reproduced deterministically by
        // withholding history until after the send.
        //
        // Scoped by room AND thread: pendingMessages is never cleared on switch,
        // so an unscoped carry would paste a message sent in one room into
        // another one's transcript.
        const room = msg.room_id || state.currentRoom;
        const carried: Array<[string, MsgRow]> = [];
        for (const [clientId, row] of state.pendingMessages) {
          if (row.roomId === room && row.threadId === state.currentThread) carried.push([clientId, row]);
        }
        setMessages([]);
        transcriptEmpty.value = null;
        msg.messages.forEach((m: any) => appendMessage(m));
        for (const [clientId, row] of carried) {
          // The echo may have raced us and the server may already have included
          // it — re-adding then would double the message.
          if (row.id && msg.messages.some((m: any) => m.id === row.id)) {
            state.pendingMessages.delete(clientId);
            continue;
          }
          state.pendingMessages.set(clientId, readdRow(row));
        }
        // Reset scroll-back pagination for the freshly loaded room. The oldest
        // rendered id anchors the first ?before_id= fetch; a window shorter than
        // the server's initial page (50) means there's nothing older to load.
        state.oldestMessageId = msg.messages.length ? msg.messages[0].id : null;
        state.noMoreOlder = msg.messages.length < 50;
        state.loadingOlder = false;
        // Carried rows count as content — otherwise a first message sent into
        // an empty room renders underneath "No messages yet."
        if (msg.messages.length === 0 && carried.length === 0) {
          transcriptEmpty.value = 'No messages yet. Start the conversation!';
        }
        // New content is in place — fade the transcript back to full (it was
        // dimmed during the switch instead of blanked).
        endTranscriptSwitch();
        if (msg.messages.length > 0) {
          setLastSeenMessageId(msg.messages[msg.messages.length - 1].id);
        }
        const sendAfter = state.pendingSendAfterJoin;
        state.pendingSendAfterJoin = null;
        if (sendAfter) triggerLearn(sendAfter);
        const jumpTo = state.pendingJumpMessageId;
        state.pendingJumpMessageId = null;
        if (jumpTo) {
          // Arrived from a search result — center + flash that message instead of
          // scrolling to the bottom (paging older history in if it's not loaded).
          void jumpToMessage(jumpTo);
        } else {
          scrollToBottom(true);
          requestAnimationFrame(() => scrollToBottom(true));
          // Extra scrolls for mobile layout settle
          setTimeout(() => scrollToBottom(true), 100);
          setTimeout(() => scrollToBottom(true), 300);
        }
        break;
      }
      case 'members':
        if (msg.room_id === state.currentRoom) {
          renderMembers(msg.members);
          // Membership may have changed (someone gained/lost access) — refresh
          // the @-mention candidate pool. (The pool itself comes from the
          // server, not this connected-members list — see fetchMentionablePeople.)
          fetchMentionablePeople();
        }
        break;
      case 'message': {
        // Bump the room's activity so it floats up in the Recent-sorted sidebar
        // without waiting for a server rooms refresh.
        if (msg.room_id && msg.created_at) {
          state.roomActivity.set(msg.room_id, Math.max(state.roomActivity.get(msg.room_id) || 0, msg.created_at));
          if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
        }
        // Thread routing: a message for another thread of the open room doesn't
        // belong in this view — flag that thread unread and stop. (Messages for
        // other rooms never reach this client; the server scopes broadcasts.)
        const msgThread = msg.thread_id || 'main';
        if ((msg.room_id || state.currentRoom) === state.currentRoom && msgThread !== state.currentThread) {
          if (msg.sender !== state.myIdentity) {
            state.threadUnread.add(msgThread);
            // The thread list repaints itself from this flag now. The guard
            // that used to sit here — skip the rebuild while the user is
            // naming or renaming a thread — was needed because
            // renderThreadList reseeded the inline input from scratch, so a
            // message on some OTHER thread silently discarded whatever they
            // had typed. The input is a keyed component Vue patches rather
            // than rebuilds, so typing survives and the unread dot no longer
            // has to wait for an unrelated render.
          }
          break;
        }
        // Snapshot the scroll position BEFORE appending. If we check after,
        // the newly-inserted message has already pushed the bottom past our
        // 80px threshold and `isNearBottom()` lies about the user's intent.
        // That's why long agent replies sometimes silently failed to scroll.
        const wasNearBottom = isNearBottom();
        // Desktop notification for messages from others when tab is not focused
        if (
          state.settings?.notifications &&
          document.hidden &&
          msg.sender !== state.myIdentity &&
          msg.message_type !== 'a2a' &&
          msg.sender_type !== 'a2a'
        ) {
          try {
            const mentioned = messageMentionsMe(msg.content);
            new Notification(mentioned ? `${msg.sender} mentioned you` : `${msg.sender}`, {
              body: msg.content.slice(0, 100),
              tag: msg.id || 'nanoclaw-msg',
              requireInteraction: mentioned,
            });
          } catch {}
        }
        if (msg.sender === state.myIdentity && msg.client_id && state.pendingMessages.has(msg.client_id)) {
          const row = state.pendingMessages.get(msg.client_id)!; // guarded by has() above
          // Upgrade the optimistic row in place: delivered tick, then the
          // server id — which is also what makes the delete button appear, so
          // there is no addDeleteButton call any more.
          row.status = '✓✓';
          state.pendingMessages.delete(msg.client_id);
          if (msg.id) row.id = msg.id;
        } else {
          appendMessage(msg);
        }
        if (msg.id && msg.room_id === state.currentRoom) {
          setLastSeenMessageId(msg.id);
          // Reading in the open, focused room: advance the server marker so the
          // badge stays cleared across this user's other devices too. Skip when
          // backgrounded — a hidden tab hasn't actually been seen.
          if (!document.hidden && state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'read', room_id: state.currentRoom, thread_id: state.currentThread }));
          }
        }
        const shouldScroll = wasNearBottom || (state.forceScrollCount > 0 && !state.userScrolledAway);
        if (shouldScroll) {
          scrollToBottom();
          // Follow late-rendering content. Markdown + DOMPurify run sync, but
          // image loads / code-block toolbars / reflow can grow the message
          // after the initial scroll. Re-scroll at rAF + 200ms so the bottom
          // tracks the final height instead of stopping mid-message.
          requestAnimationFrame(() => {
            if (!state.userScrolledAway) scrollToBottom();
          });
          setTimeout(() => {
            if (!state.userScrolledAway) scrollToBottom();
          }, 200);
          if (state.forceScrollCount > 0) state.forceScrollCount--;
        } else {
          incrementMissedMessages();
        }
        break;
      }
      case 'typing':
        handleTypingEvent(msg);
        break;
      case 'status':
        handleStatusEvent(msg);
        break;
      case 'unread':
        if (msg.room_id && msg.room_id !== state.currentRoom) {
          state.unreadRooms.add(msg.room_id);
          updateUnreadDots();
        }
        break;
      case 'mention':
        // Server says an @-mention of me landed in a room I'm not viewing.
        // Distinct, higher-signal badge than plain unread.
        if (msg.room_id && msg.room_id !== state.currentRoom) {
          state.mentionedRooms.add(msg.room_id);
          state.unreadRooms.add(msg.room_id);
          updateUnreadDots();
        }
        break;
      case 'read_cleared': {
        // Another of this user's devices read the room — drop the stale badges.
        const cleared = (msg.room_id && state.unreadRooms.delete(msg.room_id)) | 0;
        const clearedMention = (msg.room_id && state.mentionedRooms.delete(msg.room_id)) | 0;
        if (cleared || clearedMention) updateUnreadDots();
        break;
      }
      case 'delete_message':
        if (msg.message_id) {
          const el = document.querySelector(`[data-message-id="${CSS.escape(msg.message_id)}"]`);
          if (el) {
            el!.classList.add('deleting');
            setTimeout(() => el.remove(), 350);
          }
        }
        break;
      case 'approval':
        handleApprovalEvent(msg);
        break;
      case 'approval_resolved':
        handleApprovalResolvedEvent(msg);
        break;
      case 'skill_draft_review':
        // Outcome of an async Keep (learning loop) — see handleSkillDraftReview.
        handleSkillDraftReview(msg);
        break;
      case 'error':
        console.error('WS error:', msg.error);
        break;
    }
  };

  sock.onclose = () => {
    // Per-socket flag — the new socket that replaced this one is already
    // running, so we don't reconnect from here.
    if ((sock as TaggedSocket)._intentionalClose) return;
    // If another socket has since taken over (rapid reconnects, visibility
    // change), let it own the reconnect lifecycle.
    if (state.ws !== sock) return;
    setConnectionBanner('Connection lost. Reconnecting…');
    void diagnoseConnection();
    state.myIdentity = '';
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
  };
}

export async function probeInternet() {
  const hit = (url: string) =>
    fetch(url, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(4000) : undefined,
    });
  try {
    await Promise.any([
      hit('https://derp1.tailscale.com/generate_204'),
      hit('https://www.gstatic.com/generate_204'),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function setLastSeenMessageId(id: string | null) {
  state.lastSeenMessageId = id;
  if (id) sessionStorage.setItem('lastSeenMessageId', id);
}


// ── Agent status events ───────────────────────────────────────────────────
const TOOL_LABELS: Record<string, string> = {
  Bash: 'Running command',
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Glob: 'Searching files',
  Grep: 'Searching code',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching page',
  Task: 'Managing tasks',
  NotebookEdit: 'Editing notebook',
};

// Status frames carry fine-grained turn activity from the agent (see
// src/channels/webchat/index.ts sendStatus). `event` is the kind:
//   start     → a turn began; show the bubble and keep it up until done/stalled
//   tool      → text = tool name, detail = target (file/command/query)
//   progress  → text = milestone message
//   reasoning → text = a reasoning summary line (rendered by the fading feed)
//   done      → turn finished cleanly; clear the bubble
//   stalled   → turn ended abnormally (agent died/killed); notice + clear
// ── Learn surfaces ───────────────────────────────────────────────────────────
// One path for every learn trigger (composer 🎓, nudge chip, room-settings
// button, typing /learn): set the input and send. No second implementation.
// `command` lets source-directed callers send `/learn <url|path>` through the
// exact same gate (in a room, composer enabled) and send path.

// Client-side mirror of classifyLearnHint's first-token rule (container/
// agent-runner/src/learning-loop.ts): only the FIRST token decides whether the
// hint is a source; anything after it is focus text. Pre-validating here keeps
// a typo from silently degrading into a free-text steering hint.

// Shared source prompt: one input — the source first, optional focus text
// after it — composed into `/learn <value>` and sent through triggerLearn.

// The nudge: Hermes' bare heuristic (a tool-heavy turn), but human-gated — it
// suggests, the user taps, nothing runs or costs anything on its own. Dismiss
// hides it until the NEXT qualifying turn; switching rooms clears it.
const LEARN_NUDGE_MIN_TOOLS = 5;

export async function fetchMyHandle() {
  try {
    const r = await authFetch('/api/me/handle');
    if (r.ok) state.myHandle = ((await r.json()).handle || '').toLowerCase();
  } catch {
    /* non-fatal — mentions just won't self-highlight until next load */
  }
  // Reflect the loaded handle in the header chip.
  renderHandleChip();
}

export async function probeIsOwner() {
  try {
    const [check, users] = await Promise.all([authFetch('/api/auth/check'), authFetch('/api/users')]);
    if (check.ok) {
      const body = await check.json();
      if (body && typeof body.userId === 'string') permsMyUserId.value = body.userId;
    }
    if (users.ok) {
      // /api/users is now open to any admin (not just owners), so its success
      // only means "I can see the permissions panel". Reveal the toggle for
      // every admin, but derive true-owner status from my own roles in the
      // response — isOwnerView must stay owner-only since it gates owner-only
      // write controls (e.g. room assignment).
      $('#overflow-permissions')!.hidden = false;
      // Admin is any-admin for the same reason: its blocks self-hide on 403,
      // so a scoped admin gets a page containing exactly what they may touch.
      $('#overflow-admin')!.hidden = false;
      // Journey (the learning timeline) is admin-tier like the drafts list it
      // mirrors — not marketplace-gated; the server 403s non-admins anyway.
      $('#overflow-journey')?.removeAttribute('hidden');
      // /api/users success = admin+ → gates the admin-only slash menu.
      isAdminView.value = true;
      // MCP + skills registries are admin-only AND can be turned off workspace-
      // wide (the marketplace toggle). Reveal their menu items + tabs only when
      // both hold; the server 403s the endpoints when off, so this is just UX.
      try {
        const fr = await authFetch('/api/webchat/features');
        const feats = fr.ok ? await fr.json() : {};
        state.marketplaceEnabled = feats.marketplaceEnabled === true;
        renderCredentialIsolation(feats);
      } catch {
        state.marketplaceEnabled = false;
      }
      if (state.marketplaceEnabled) {
        $('#overflow-mcp')?.removeAttribute('hidden');
        $('#mtab-mcp-btn')?.removeAttribute('hidden');
        $('#mtab-skills-btn')?.removeAttribute('hidden');
        $('#overflow-skills')?.removeAttribute('hidden');
      }
      const list = await users.json().catch(() => []);
      const me = Array.isArray(list) ? list.find((u) => u.id === permsMyUserId.value) : null;
      state.isOwnerView = !!(me && userIsOwner(me));
      return true;
    }
  } catch {}
  state.isOwnerView = false;
  isAdminView.value = false;
  return false;
}

export function handleStatusEvent(msg: any) {
  if (msg.room_id !== state.currentRoom) return;
  // Each frame names its agent (host stamps agent_name); fall back to the room's
  // single agent name so old/unattributed frames still land on one bubble.
  const name = msg.agent_name || state.agentName || 'Agent';
  switch (msg.event) {
    case 'start':
      beginAgentTurn(name);
      learnTurnToolCount.value = 0;
      break;
    case 'tool': {
      markTurnActivity(name);
      learnTurnToolCount.value++;
      const verb = msg.text ? TOOL_LABELS[msg.text] || `Using ${msg.text}` : 'Working';
      updateThinkingBubble(name, verb, msg.detail || null);
      break;
    }
    case 'progress':
      markTurnActivity(name);
      if (msg.text) setThinkingMilestone(name, msg.text);
      break;
    case 'reasoning':
      markTurnActivity(name);
      if (msg.text) pushReasoning(name, msg.text);
      break;
    case 'done':
      endAgentTurn(name);
      // A tool-heavy turn is the design's first heuristic signal — worth
      // offering to keep. Never fires for /learn's own turn: the review pass
      // uses one restricted tool at most.
      if (learnTurnToolCount.value >= LEARN_NUDGE_MIN_TOOLS && roomAutoLearn.get(state.currentRoom ?? '') !== true) showLearnNudge();
      learnTurnToolCount.value = 0;
      break;
    case 'stalled':
      endAgentTurn(name);
      appendSystem(msg.text || 'The agent stopped responding. You may want to resend your message.');
      break;
  }
}
