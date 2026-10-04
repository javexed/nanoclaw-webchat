// ── WebSocket transport ──────────────────────────────────────────────────────
// The socket lifecycle and the message dispatcher: open/close/retry with
// backoff, and the switch that turns every server event into a transcript,
// room-list, thread, approval or status update. Also the connection banner and
// the diagnose-on-failure probe.
import { $ } from '../core/dom.js';
import { checkSessionExpired, clearSessionExpired, sessionExpiredShown } from './session-expiry.js';
import { learnTurnToolCount, roomAutoLearn, roomsReceived } from '../features/room-list-state.js';
import { pushReasoning, pushTool, setThinkingMilestone, setTurnMeta, updateThinkingBubble } from '../features/thinking.js';
import { forgetTrace } from '../features/turn-trace-view.js';
import { renderCredentialIsolation } from '../features/settings.js';
import { isAdminView, isWorkspaceAdminView } from './state.js';
import { permsMyUserId } from '../features/perms-list-state.js';
import { joinRoom, renderRooms, updateUnreadDots } from '../features/rooms.js';
import { renderHandleChip, renderMembers, userIsOwner } from '../features/members.js';
import { userIsGlobalAdmin } from '../features/perms-user-info.js';
import { showLearnNudge, triggerLearn } from '../features/learn.js';
import { fetchMentionablePeople, handleTypingEvent } from '../features/composer.js';
import {
  beginAgentTurn,
  endAgentTurn,
  markTurnActivity,
  refreshWiredAgentsForCurrentRoom,
} from '../features/agents.js';
import { showToast } from '../core/toast.js';
import { apiJson, authFetch, getWsUrl, getWsProtocols } from '../core/api.js';
import { state } from '../core/state.js';
import { messages, readdRow, transcriptEmpty, type MsgRow } from '../features/transcript-state.js';
import {
  appendMessage,
  appendSystem,
  isNearBottom,
  scrollToBottom,
  setMessages,
  updateScrollButton,
  incrementMissedMessages,
  messageMentionsMe,
  jumpToMessage,
  endTranscriptSwitch,
} from '../features/transcript.js';
import { fetchApprovals, handleApprovalEvent, handleApprovalResolvedEvent } from '../features/approvals.js';
import { handleSkillDraftReview, refreshDraftBadge } from '../features/skills.js';

/** Supplied by provideWsDeps in composition-root.ts. Types check the shapes;
 *  check:deps checks that each one is actually supplied. */
/**
 * The socket, plus the one marker we hang on it. `_intentionalClose` tells the
 * close handler that WE closed the socket (reconnect, logout) so it must not
 * schedule a retry. Declaring it beats casting at each of the three use sites.
 */
export interface TaggedSocket extends WebSocket {
  _intentionalClose?: boolean;
}

export interface WsDeps {}

const deps = {} as WsDeps;

/** Wire the composition-root helpers the dispatcher calls. Call once at startup. */
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

// ── Connection diagnosis ───────────────────────────────────────────────────
// "Reconnecting…" alone can't tell the user WHERE the path broke. Three states
// are distinguishable from a browser:
//   offline — navigator.onLine is false (no network at all)
//   no-path — an internet probe succeeds but the server stays unreachable; on
//             a Tailscale-auth install that means Tailscale is off on THIS
//             device (we can't probe tailscaled itself: Quad100 is plain HTTP,
//             blocked as mixed content from an HTTPS page)
//   unknown — the probe failed too; plain "no internet" wording
// The probe races two no-cors /generate_204 fetches (Tailscale's own DERP
// relay + gstatic; both CSP-allowed in server.ts): an opaque response
// resolving proves internet works without reading any content. Throttled —
// reconnect retries fire on a backoff and don't each need a fresh probe.
export async function diagnoseConnection() {
  if (!navigator.onLine) {
    setConnectionBanner('You’re offline. Reconnecting when the network returns…');
    return;
  }
  // Not down at all: the sign-in front door wants a sign-in (session-expiry.ts).
  if (await checkSessionExpired()) return;
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
    clearSessionExpired();
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
        roomsReceived.value = true;
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
          // Rejoin after reconnect — catch up on missed messages. Also the
          // DEFERRED join (joinRoom skips its send on a connecting socket), so it
          // carries thread_id or the user would land back in 'main'.
          state.ws?.send(
            JSON.stringify({ type: 'join', room_id: state.currentRoom, thread_id: state.currentThread || 'main' }),
          );
          if (state.lastSeenMessageId) {
            apiJson(`/api/rooms/${state.currentRoom}/messages?after_id=${state.lastSeenMessageId}`)
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
        // Carry pending sends across the history reset: a message sent between
        // the join and this reply is not in the payload, and its echo only
        // upgrades a row in place, so a wiped row would never reappear. Scoped by
        // room AND thread: pendingMessages is never cleared on switch.
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
            // The thread list repaints from this flag; its inline input is keyed,
            // so a rename in progress survives the patch.
          }
          break;
        }
        // Snapshot the scroll position BEFORE appending: afterwards the new
        // message has pushed the bottom past the 80px threshold.
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
        // By client id alone: this tab generated it, and the server echoes it
        // only on this sender's own message. Matching the sender NAME as well
        // failed whenever the server's name for us changed mid-session (a
        // sign-in falling back to another path), and every message showed twice.
        if (msg.client_id && state.pendingMessages.has(msg.client_id)) {
          const row = state.pendingMessages.get(msg.client_id)!; // guarded by has() above
          // Upgrade the optimistic row in place: delivered tick, then the server
          // id (which is what makes the delete button appear).
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
      case 'turn_meta':
        // Harness · model · host for a turn that just started (turn-traces.ts).
        if (msg.room_id === state.currentRoom)
          setTurnMeta(msg.agent_name || state.agentName || 'Agent', {
            harness: msg.harness ?? null,
            model: msg.model ?? null,
            host: msg.host ?? null,
          });
        break;
      case 'trace': {
        // A reply's turn was stored: its Thoughts can now be fetched.
        if (!msg.message_id) break;
        forgetTrace(msg.message_id);
        const row = messages.value.find((r) => r.id === msg.message_id);
        if (row) row.hasTrace = true;
        break;
      }
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
        // A send the server could not store: mark its bubble instead of
        // leaving it on the single tick.
        if (msg.client_id && state.pendingMessages.has(msg.client_id)) {
          state.pendingMessages.get(msg.client_id)!.status = 'Not sent';
          state.pendingMessages.delete(msg.client_id);
          showToast('Message not sent. Try again.', { kind: 'error' });
        }
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
    // An expired sign-in is already explained, with its button: keep that up and retry quietly
    // (a sign-in in another tab brings the socket back).
    if (!sessionExpiredShown()) {
      setConnectionBanner('Connection lost. Reconnecting…');
      void diagnoseConnection();
    }
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
    await Promise.any([hit('https://derp1.tailscale.com/generate_204'), hit('https://www.gstatic.com/generate_204')]);
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

// The nudge: Hermes' bare heuristic (a tool-heavy turn), but human-gated — it
// suggests, the user taps, nothing runs or costs anything on its own. Dismiss
// hides it until the NEXT qualifying turn; switching rooms clears it.
const LEARN_NUDGE_MIN_TOOLS = 5;

// Load my @-mention handle (server-stored, settable in Settings), for
// highlight + notify on @-mentions of me. Best-effort.
export async function fetchMyHandle() {
  try {
    state.myHandle = ((await apiJson('/api/me/handle')).handle || '').toLowerCase();
  } catch {
    /* non-fatal — mentions just won't self-highlight until next load */
  }
  // Reflect the loaded handle in the header chip.
  renderHandleChip();
}

// Bumped by every probe. Probes overlap (each `rooms` frame starts one), so a
// slow one that lost a race drops its result instead of overwriting a newer one.
let probeSeq = 0;

export async function probeIsOwner() {
  const seq = ++probeSeq;
  const superseded = () => seq !== probeSeq;
  try {
    const [check, users] = await Promise.all([authFetch('/api/auth/check'), authFetch('/api/users')]);
    if (superseded()) return isAdminView.value;
    if (check.ok) {
      const body = await check.json();
      if (body && typeof body.userId === 'string') permsMyUserId.value = body.userId;
    }
    if (users.ok) {
      // /api/users succeeds for any admin: reveal the toggle for every admin,
      // but derive owner status from my own roles — isOwnerView gates owner-only
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
      // Resolved before the reveal below, which depends on it.
      const list = await users.json().catch(() => []);
      if (superseded()) return isAdminView.value;
      const me =Array.isArray(list) ? list.find((u) => u.id === permsMyUserId.value) : null;
      state.isOwnerView = !!(me && userIsOwner(me));
      // Sign-in: owner or global admin, the same audience its endpoint allows.
      isWorkspaceAdminView.value = state.isOwnerView || !!(me && userIsGlobalAdmin(me));
      $('#overflow-signin')!.hidden = !isWorkspaceAdminView.value;
      // Server extensions installed as skills (the VS Code runner, …): their
      // screens stay hidden unless listed.
      let extensions: string[] = [];
      try {
        const fr = await authFetch('/api/webchat/features');
        const feats = fr.ok ? await fr.json() : {};
        state.marketplaceEnabled = feats.marketplaceEnabled === true;
        extensions = Array.isArray(feats.extensions) ? feats.extensions : [];
        renderCredentialIsolation(feats);
      } catch {
        state.marketplaceEnabled = false;
      }
      // MCP + skills: admin-only, and the marketplace toggle can hide the
      // catalogs. The owner clause is required: these tabs also hold the catalog
      // SOURCES and the toggle itself, and a surface an owner configures must not
      // be gated behind the state it configures (same as the Routing tab).
      if (state.marketplaceEnabled || state.isOwnerView) {
        $('#overflow-mcp')?.removeAttribute('hidden');
        $('#mtab-mcp-btn')?.removeAttribute('hidden');
        $('#mtab-skills-btn')?.removeAttribute('hidden');
        // Runners: paired developer machines, when the VS Code runner is
        // installed. Owner/global-admin surface; the API 403s anyone else, so
        // revealing on the owner view is enough here.
        if (extensions.includes('vscode')) {
          $('#mtab-runners-btn')?.removeAttribute('hidden');
          $('#overflow-runners')?.removeAttribute('hidden');
        }
        // Network: the install's egress allowlist (every agent). Same audience.
        $('#mtab-network-btn')?.removeAttribute('hidden');
        $('#overflow-network')?.removeAttribute('hidden');
        $('#overflow-skills')?.removeAttribute('hidden');
      }
      return true;
    }
    // Only the server saying no demotes. A 502 from a front door while the
    // server restarts is not an answer about roles; the next reconnect re-probes.
    if (users.status === 401 || users.status === 403) {
      state.isOwnerView = false;
      isAdminView.value = false;
      isWorkspaceAdminView.value = false;
      return false;
    }
  } catch {
    // Network error — same as a 5xx: keep what we had.
  }
  return isAdminView.value;
}

// Status frames carry fine-grained turn activity from the agent (see
// src/channels/webchat/index.ts sendStatus). `event` is the kind:
//   start     → a turn began; show the bubble and keep it up until done/stalled
//   tool      → text = tool name, detail = target (file/command/query)
//   progress  → text = milestone message
//   reasoning → text = a reasoning summary line (rendered by the fading feed)
//   done      → turn finished cleanly; clear the bubble
//   stalled   → turn ended abnormally (agent died/killed); notice + clear
export function handleStatusEvent(msg: any) {
  if (msg.room_id !== state.currentRoom) return;
  // Each frame names its agent (host stamps agent_name); fall back to the room's
  // single agent name so unattributed frames still land on one bubble.
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
      if (msg.text) pushTool(name, msg.text, msg.detail || null);
      break;
    }
    case 'progress':
      markTurnActivity(name);
      if (msg.text) setThinkingMilestone(name, msg.text);
      break;
    case 'reasoning':
      markTurnActivity(name);
      if (msg.text) pushReasoning(name, msg.text, msg.detail ?? undefined);
      break;
    case 'done':
      endAgentTurn(name);
      // A tool-heavy turn is the design's first heuristic signal — worth
      // offering to keep. Never fires for /learn's own turn: the review pass
      // uses one restricted tool at most.
      if (learnTurnToolCount.value >= LEARN_NUDGE_MIN_TOOLS && roomAutoLearn.get(state.currentRoom ?? '') !== true)
        showLearnNudge();
      learnTurnToolCount.value = 0;
      break;
    case 'stalled':
      endAgentTurn(name);
      appendSystem(msg.text || 'The agent stopped responding. You may want to resend your message.');
      break;
  }
}
