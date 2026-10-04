// ── Transcript ───────────────────────────────────────────────────────────────
// The message list itself: building and appending bubbles, code-block and
// mention decoration, the older-messages pager, jump-to-message, and the whole
// scroll-follow discipline (near-bottom detection, forced scrolls, the missed-
// message counter).
import { marked } from '/marked.min.js';
import { respondToApproval } from './approvals.js';
import DOMPurify from '/dompurify.min.js';
import { createApp } from 'vue';
import Transcript from './Transcript.vue';
import CodeToolbar from './CodeToolbar.vue';
import { $ } from '../core/dom.js';
import { mountIsland } from '../core/island.js';
import { state } from '../core/state.js';
import { showToast } from '../core/toast.js';
import { apiJson } from '../core/api.js';
import {
  messages,
  nextKey,
  thinkingTurns,
  turnFor,
} from './transcript-state.js';
import type { MsgRow } from './transcript-state.js';
import { traceHasContent, traceViewFromTurn, type TraceView } from './turn-trace-view.js';

/** Supplied by provideTranscriptDeps in composition-root.ts. `any` marks a signature not
 *  yet typed, not an opt-out of checking. */
export interface TranscriptDeps {
  agentColor: (a0?: any) => any;
  skillDraftRow: (a0?: any) => any;
  openLightbox: (a0: string, a1: string) => any;
  interruptAgent: (a0: string) => any;
  toggleThinkingExpanded: (a0: string) => any;
  endAgentTurn: (a0?: any) => any;
  mentionAgentColor: (a0?: any) => any;
}

const deps = {} as TranscriptDeps;

/** Wire the composition-root helpers the transcript calls. Call once at startup. */
export function provideTranscriptDeps(provided: Partial<TranscriptDeps>): void {
  Object.assign(deps, provided);
}

/**
 * Give every fenced block a Wrap / Copy strip by mounting CodeToolbar. The
 * has-code-toolbar guard keeps it idempotent across markdown re-renders. Apps
 * are not tracked for unmount: each lives exactly as long as its v-html <pre>.
 */
function decorateCodeBlocks(container?: any) {
  container.querySelectorAll('pre').forEach((pre: any) => {
    if (pre.classList.contains('has-code-toolbar')) return;
    pre.classList.add('has-code-toolbar');

    const code = pre.querySelector('code');
    const langClass = code && [...code.classList].find((c: string) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';

    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    pre.insertBefore(toolbar, pre.firstChild);
    createApp(CodeToolbar, { lang, pre }).mount(toolbar);
  });
}

// True when `text` contains an @-mention of the current user's handle. Mirrors
// the token boundary used by decorateMentions so highlight + notify agree.
export function messageMentionsMe(text?: any) {
  if (!state.myHandle || typeof text !== 'string') return false;
  const re = new RegExp('(?:^|[^a-z0-9_-])@' + state.myHandle + '(?![a-z0-9-])', 'i');
  return re.test(text);
}

// Smooth room/thread switches: instead of blanking the transcript to a
// "Loading…" flash (a jarring gap while the async `history` message is in
// flight), keep the previous messages visible but dimmed until the new history
// arrives and swaps them in (the 'history' handler calls endTranscriptSwitch).
// A fallback un-dims if history never lands (e.g. a socket hiccup).
let roomSwitchDimTimer: ReturnType<typeof setTimeout> | undefined;

export function beginTranscriptSwitch() {
  const el = $('#messages')!;
  el.classList.add('room-switching');
  clearTimeout(roomSwitchDimTimer);
  roomSwitchDimTimer = setTimeout(() => el.classList.remove('room-switching'), 2000);
}

export function endTranscriptSwitch() {
  clearTimeout(roomSwitchDimTimer);
  $('#messages')!.classList.remove('room-switching');
}

function formatTime(ts?: any) {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Today's messages stay time-only to avoid clutter; anything older gets a date
  // so you can tell at a glance how old it is.
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  // Same calendar year → "Jun 20, 14:32"; older → include the year.
  const dateOpts =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
  return `${d.toLocaleDateString([], dateOpts as Intl.DateTimeFormatOptions)}, ${time}`;
}

/**
 * Turn a server message into a transcript ROW. Decided ONCE, here, because it
 * reads state gone by the next render (see transcript-state.ts).
 */
export function appendMessage(msg?: any, statusText?: any, prepend?: boolean): MsgRow | undefined {
  // One row per server message. A live broadcast and a reconnect catch-up
  // (or a read-sync refetch) can deliver the same message twice; the second
  // arrival must not become a second row. Optimistic rows have no id yet and
  // are upgraded in place by the ws handler, so they are unaffected.
  if (msg?.id) {
    const existing = messages.value.find((r) => r.id === msg.id);
    if (existing) return existing;
  }
  if (msg.type === 'system') return appendSystem(msg.message);
  if (msg.message_type === 'approval' || msg.message_type === 'approval_resolved') {
    return pushRow(approvalRow(msg), prepend);
  }
  if (msg.message_type === 'skill_draft') {
    return pushRow(deps.skillDraftRow(msg), prepend);
  }
  // Context-sync divider: a labelled rule marking where pulled/pushed messages
  // begin. See docs/webchat/threads.md §8.
  if (msg.message_type === 'context-divider') {
    return pushRow({ key: nextKey(), kind: 'divider', text: msg.content || 'Synced context' }, prepend);
  }

  const isMine = msg.sender === state.myIdentity;
  // Side-channel a2a copy (agent→agent surfaced into a shared room). Marked via
  // message_type/sender_type='a2a'; content is {to, text}. Rendered distinctly
  // and NOT treated as an agent message (so it never removes the thinking bubble
  // or counts as the room's active agent reply).
  const isA2a = msg.message_type === 'a2a' || msg.sender_type === 'a2a';
  const isAgent = !isA2a && msg.sender_type === 'agent';
  let a2aTo = null;
  let a2aText = msg.content;
  if (isA2a) {
    try {
      const parsed = JSON.parse(msg.content);
      a2aTo = parsed.to ?? null;
      a2aText = typeof parsed.text === 'string' ? parsed.text : msg.content;
    } catch {
      /* plain (non-JSON) content — render as-is */
    }
  }

  // An agent message means the turn produced output — end the turn (clears the
  // bubble + elapsed timer). Covers reconnect catch-up too. Snapshot the turn's
  // reasoning so it can be folded onto THIS reply as a "Thoughts" disclosure,
  // then clear it so only the first reply of the turn carries it.
  let thoughtsForThisMsg = null;
  let liveTrace: TraceView | null = null;
  if (isAgent) {
    // Fold THIS agent's reasoning onto its reply and clear ITS turn only — not
    // another agent's that may still be thinking. Match by name; if there is a
    // lone turn (single-agent room), use it even on a name mismatch.
    let turn = turnFor(msg.sender);
    if (!turn && thinkingTurns.value.length === 1) turn = thinkingTurns.value[0];
    if (turn) {
      if (turn.reasoningLog.length > 0) thoughtsForThisMsg = turn.reasoningLog.slice();
      const view = traceViewFromTurn(turn, Date.now());
      if (traceHasContent(view)) liveTrace = view;
      deps.endAgentTurn(turn.name);
    }
  }

  const body = isA2a ? a2aText : msg.content;
  const isFile = msg.message_type === 'file' && !!msg.file_meta;
  // Markdown is best-effort: a malformed message must not crash the render loop
  // and leave the transcript half-populated. Falls back to plain text (escaped
  // by the DOM, no XSS risk) if marked or DOMPurify throws.
  let html: string | null = null;
  if (!isFile) {
    try {
      // Explicit config rather than DOMPurify defaults. marked never emits
      // forms or style attributes, so forbidding them costs rendering nothing
      // — but the default allows both, and with the CSP carrying style-src
      // 'unsafe-inline' a "sanitized" LLM message could still restyle its own
      // bubble into a fake UI (style=) or draw input fields (forms). Belt for
      // the CSP's one deliberate gap.
      html = DOMPurify.sanitize(marked.parse(body), {
        FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'style'],
        FORBID_ATTR: ['style'],
      });
    } catch (err: any) {
      console.error('Message render failed; falling back to plain text', err);
      html = null;
    }
  }

  const timeStr = formatTime(msg.created_at);
  const row: MsgRow = {
    key: nextKey(),
    kind: 'msg',
    id: msg.id ?? null,
    cls:
      (isA2a ? 'msg a2a' : isMine ? 'msg mine' : isAgent ? 'msg agent' : 'msg other') +
      // Highlight messages that @-mention me (not my own). Bubble-level accent +
      // the per-token .mention-me chip from decorateMentions.
      (!isMine && messageMentionsMe(body) ? ' mentions-me' : ''),
    isMine,
    isAgent,
    isA2a,
    sender: msg.sender,
    a2aTo,
    // Tint the card's accent bar in the sending agent's colour (see .msg.a2a
    // border-left in style.css). The header names carry the same colours.
    a2aAccent: isA2a ? deps.agentColor(msg.sender) : undefined,
    senderColor: isA2a ? deps.agentColor(msg.sender) : undefined,
    toColor: isA2a && a2aTo ? deps.agentColor(a2aTo) : undefined,
    html,
    text: html === null ? body : null,
    file: isFile ? msg.file_meta : null,
    caption: isFile && msg.content && msg.content !== msg.file_meta.filename ? msg.content : null,
    thoughts: thoughtsForThisMsg,
    liveTrace,
    hasTrace: msg.has_trace === true,
    ttsText: isAgent && msg.content ? msg.content : null,
    timeStr,
    timeTitle: msg.created_at ? new Date(msg.created_at).toLocaleString() : undefined,
    status: isMine && statusText ? statusText : null,
    // Own messages ALWAYS get the .msg-body row — even the optimistic echo with
    // no server id. A bare bubble that is a direct flex child of .msg.mine
    // (align-items:flex-end) shrink-collapses its block Markdown to ~zero width
    // and renders invisible; the row gives the bubble a width context.
    body: isMine,
  };
  return pushRow(row, prepend);
}

/** Append, or PREPEND for older-message pagination. */
function pushRow(row: MsgRow, prepend?: boolean): MsgRow {
  // A row whose key is already in the list REPLACES it rather than appending a
  // second copy. Only rows with a stable identity can collide: message rows
  // carry nextKey() counters, while a skill-draft card is keyed `draft:<id>`
  // precisely so the server's resolve re-broadcast updates the card in place.
  const at = messages.value.findIndex((r) => r.key === row.key);
  if (at !== -1) {
    const next = [...messages.value];
    next[at] = row;
    messages.value = next;
    return messages.value[at];
  }
  if (prepend) messages.value = [row, ...messages.value];
  else messages.value = [...messages.value, row];
  // The PROXIED row, not the literal: callers keep these (the optimistic echo,
  // the upload status line) and mutate them, and a mutation on the raw object
  // notifies nothing.
  return prepend ? messages.value[0] : messages.value[messages.value.length - 1];
}

/** Drop a row — the upload status line removes itself when the upload ends. */
export function removeRow(row: MsgRow): void {
  messages.value = messages.value.filter((r) => r.key !== row.key);
}

/** In-room approval card. Actionable for eligible approvers; others see a
 *  read-only note, and a resolved card is a static note. */
function approvalRow(msg: any): MsgRow {
  let data: any = {};
  try {
    data = JSON.parse(msg.content ?? '{}') || {};
  } catch {
    data = {};
  }
  const questionId = data.questionId || msg.id || '';
  const resolved = msg.message_type === 'approval_resolved' || !!data.resolvedBy;
  const eligible = Array.isArray(data.approvers) && data.approvers.includes(state.myIdentity);
  const who = data.resolvedBy ? ' by ' + (String(data.resolvedBy).split(':').pop() ?? '').split('@')[0] : '';
  return {
    key: nextKey(),
    kind: 'approval',
    id: questionId,
    approvalState: resolved ? 'resolved' : eligible ? 'eligible' : 'awaiting',
    note: resolved
      ? `🔒 ${data.title || 'Approval'} — resolved${who}`
      : `🔒 ${data.title || 'Approval requested'} — awaiting an admin`,
    payload: { questionId, title: data.title, payload: data.question, options: data.options },
  };
}

export function appendSystem(text?: any): MsgRow {
  return pushRow({ key: nextKey(), kind: 'system', text }, false);
}

// During a search-jump we page older history in a tight loop; suppress
// loadOlderMessages' per-page scroll re-pin so the viewport doesn't bounce —
// jumpToMessage does one clean scroll at the end instead.
let suppressScrollRestore = false;

export async function loadOlderMessages() {
  if (state.loadingOlder || state.noMoreOlder || !state.currentRoom || !state.oldestMessageId) return;
  state.loadingOlder = true;
  const el = $('#messages')!;
  // Snapshot scroll geometry so the viewport stays pinned to the same message
  // after prepending — on desktop #messages scrolls, on mobile the window does.
  const prevElHeight = el.scrollHeight;
  const prevElTop = el.scrollTop;
  const prevDocHeight = document.documentElement.scrollHeight;
  const prevWinY = window.scrollY;
  try {
    const older = await apiJson(
      `/api/rooms/${encodeURIComponent(state.currentRoom)}/messages?before_id=${encodeURIComponent(state.oldestMessageId)}`,
    );
    if (!Array.isArray(older) || older.length === 0) {
      state.noMoreOlder = true;
      return;
    }
    // Dedupe against what's already rendered: guards page-boundary overlaps and
    // stays correct if the request hit a backend that doesn't honor before_id
    // (it would echo recent messages — all already on screen → nothing fresh).
    const fresh = older.filter((m) => !m.id || !el.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`));
    if (fresh.length === 0) {
      state.noMoreOlder = true;
      return;
    }
    // Prepending in order would reverse the page: each unshift lands in front
    // of the last, so walk it backwards.
    [...fresh].reverse().forEach((m) => appendMessage(m, undefined, true));
    state.oldestMessageId = older[0].id; // advance from the oldest FETCHED id (paging anchor)
    if (older.length < 50) state.noMoreOlder = true; // short page → reached the start
    // Restore position: add the height the prepend introduced. Skipped during a
    // search-jump — jumpToMessage scrolls to the target once at the end, so
    // per-page re-pinning would just make the viewport bounce.
    if (!suppressScrollRestore) {
      requestAnimationFrame(() => {
        el.scrollTop = prevElTop + (el.scrollHeight - prevElHeight);
        window.scrollTo(0, prevWinY + (document.documentElement.scrollHeight - prevDocHeight));
      });
    }
  } catch {
    /* leave noMoreOlder false so a later scroll-to-top retries */
  } finally {
    state.loadingOlder = false;
  }
}

// Center + briefly flash a specific message (used by search-result clicks). If
// the target isn't in the loaded window, page older history in until it appears
// (or we run out / hit a safety cap), then scroll to it. Reuses the same
// ?before_id= pagination as scroll-back, so no backend change is needed.
export async function jumpToMessage(messageId?: any) {
  if (!messageId) return;
  const find = () => $('#messages')!.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  let el = find()!;
  if (!el) {
    // Off-screen hit: page older history in (no per-page re-pin) until it appears.
    suppressScrollRestore = true;
    try {
      let guard = 0;
      while (!el && !state.noMoreOlder && guard < 40) {
        const before = state.oldestMessageId;
        await loadOlderMessages();
        el = find() as Element;
        if (state.oldestMessageId === before) break; // no progress (error / nothing fresh) — stop
        guard++;
      }
    } finally {
      suppressScrollRestore = false;
    }
  }
  if (!el) {
    showToast('Couldn’t find that message — it may be too old to load.', { kind: 'info' });
    return;
  }
  // Let the prepends/layout settle, then do ONE definitive scroll + flash so the
  // message is stably centered (and in view) for the whole highlight.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  el.scrollIntoView({ block: 'center' });
  el.classList.add('jump-highlight');
  setTimeout(() => el.classList.remove('jump-highlight'), 2500);
}

export function scrollToBottom(instant?: any) {
  const el = $('#messages')!;
  el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
  // Also scroll window for mobile where body scrolls instead of #messages
  window.scrollTo({ top: document.body.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

export function isNearBottom() {
  const el = $('#messages')!;
  const elNear = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const winNear = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 80;
  // Both must be near bottom — on mobile the window scrolls (elNear is always
  // true because #messages doesn't overflow), on desktop #messages scrolls.
  return elNear && winNear;
}

// Coalesce multiple image-load re-scroll requests into a single rAF call so
// many simultaneous loads don't queue up overlapping scrollTo invocations.
let pendingFollowScroll = false;

export function scheduleFollowScroll() {
  if (pendingFollowScroll) return;
  pendingFollowScroll = true;
  requestAnimationFrame(() => {
    pendingFollowScroll = false;
    if (!state.userScrolledAway) scrollToBottom();
  });
}

export function updateScrollButton() {
  if (isNearBottom()) {
    $('#scroll-bottom')!.hidden = true;
    state.missedMsgCount = 0;
    $('#unread-badge')!.textContent = '';
  } else {
    $('#scroll-bottom')!.hidden = false;
    $('#unread-badge')!.textContent = state.missedMsgCount > 0 ? String(state.missedMsgCount) : '';
  }
}

export function incrementMissedMessages() {
  if (!isNearBottom()) {
    state.missedMsgCount = state.missedMsgCount + 1;
    updateScrollButton();
  }
}

/**
 * Walk a rendered bubble's text nodes and wrap `@<slug>` tokens in a styled
 * span. Cosmetic only — even if the token doesn't match a wired agent, the
 * styling tells the user "this looks like a mention." Server-side matching
 * is what actually decides routing.
 */
export function decorateMentions(bubble?: any) {
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip code/pre — we don't want to chip-style stuff inside backticks.
      let p = node.parentNode;
      while (p && p !== bubble) {
        const tag = p.nodeName;
        if (tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  const re = /(^|\s)@([a-z0-9-]+)\b/gi;
  for (const node of nodes) {
    const txt = node.nodeValue!;
    if (!/@[a-z0-9-]/i.test(txt)) continue;
    re.lastIndex = 0;
    let last = 0;
    let m;
    const frag = document.createDocumentFragment();
    let touched = false;
    while ((m = re.exec(txt)) !== null) {
      const fullStart = m.index + m[1].length; // skip the leading whitespace match
      if (fullStart > last) frag.appendChild(document.createTextNode(txt.slice(last, fullStart)));
      const span = document.createElement('span');
      span.className = 'mention';
      const handle = m[2].toLowerCase();
      if (state.myHandle && handle === state.myHandle) {
        // A mention of me keeps the distinct self-highlight (warning tint).
        span.classList.add('mention-me');
      } else {
        // A mention of a wired agent is tinted in that agent's colour (the same
        // hash palette as a2a labels), so @code-reviewer reads in its colour.
        const color = deps.mentionAgentColor(handle);
        if (color) span.style.background = color;
      }
      span.textContent = `@${m[2]}`;
      frag.appendChild(span);
      last = fullStart + 1 + m[2].length;
      touched = true;
    }
    if (!touched) continue;
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

// ── Panel wiring ─────────────────────────────────────────────────────────────
// The transcript surface: scroll-follow and the jump-to-latest control.
// Called from composition-root.ts at its place in boot order rather than run at module scope (check-boot-order.sh).

let transcriptApp: any = null;

/**
 * Mount the transcript into <div id="messages">, once. The container keeps its
 * imperative flags (.room-switching, .drag-over): Vue owns its CHILDREN only.
 */
export function mountTranscript(): void {
  transcriptApp ??= mountIsland('#messages', () =>
    createApp(Transcript, {
      // decorateCodeBlocks and decorateMentions post-process the sanitised
      // markdown, which Vue holds as an opaque v-html subtree — so they are
      // decorating a black box, not competing to render it.
      decorate: (bubble: HTMLElement) => {
        decorateCodeBlocks(bubble);
        decorateMentions(bubble);
      },
      clampA2a: (bubble: HTMLElement, container: HTMLElement) => applyA2aClamp(bubble, container),
      onApprovalRespond: (questionId: string, value: string) => respondToApproval(questionId, value),
      onOpenLightbox: (url: string, filename: string) => deps.openLightbox(url, filename),
      onStopAgent: (name: string) => deps.interruptAgent(name),
      onToggleTurn: (name: string) => deps.toggleThinkingExpanded(name),
    }),
  );
}

export function wireTranscriptPanel(): void {
  mountTranscript();
  $<HTMLButtonElement>('#scroll-bottom')?.addEventListener('click', () => {
    state.missedMsgCount = 0;
    state.userScrolledAway = false;
    // Clear input markers so the imminent smooth scroll doesn't get tagged as
    // user-driven by a stale wheel/touch from just before the click.
    clearUserScrollMarkers();
    const badge = $('#unread-badge');
    if (badge) badge.textContent = '';
    scrollToBottom();
  });

  // Catch images that load after the 200ms re-scroll window expires. CAPTURE
  // phase because `load` does not bubble; scheduleFollowScroll coalesces them.
  $('#messages')?.addEventListener(
    'load',
    (e) => {
      if ((e.target as Element | null)?.tagName === 'IMG') scheduleFollowScroll();
    },
    true,
  );
}

// ── Scroll tracking ──────────────────────────────────────────────────────────
// The user-scroll markers and the follow/unfollow logic behind scrollToBottom,
// Declarations are module scope; executing statements run in
// wireScrollTracking(), whose call site fixes their place in boot order.

// Show/hide scroll-to-bottom button; detect user scrolling away.
//
// Programmatic scrolls (our scrollToBottom) fire scroll events too. Without
// gating, those mid-animation events see "not at bottom yet" and flip
// userScrolledAway=true / forceScrollCount=0 — which then prevents
// late-arriving thinking bubbles from auto-scrolling. Only treat a scroll
// event as user-driven if the user actually did something to cause it
// (wheel, touch, or a scroll-relevant key) recently.
//
// Touch is tracked specially: iOS momentum scrolling continues to fire scroll
// events for up to ~1s after touchend with no touchmove in between. We arm a
// `momentumUntil` window when a real flick gesture ends so those events still
// count as user-driven.
let lastUserScrollAt = 0;
let touchMovedThisGesture = false;
let momentumUntil = 0;

/**
 * Clear the user-scroll markers so an imminent PROGRAMMATIC scroll is not
 * mistaken for a user-driven one by a stale wheel/touch from moments earlier.
 * Also used by composer.ts's send path.
 */
export function clearUserScrollMarkers(): void {
  lastUserScrollAt = 0;
  momentumUntil = 0;
}

const markUserScroll = () => {
  lastUserScrollAt = Date.now();
};
function handleScroll() {
  updateScrollButton();
  // Near the top → pull in older history. #messages scrolls on desktop, the
  // window scrolls on mobile; check whichever actually overflows so we don't
  // false-trigger on the axis that never moves.
  const el = $('#messages');
  if (!el) return;
  const elScrolls = el.scrollHeight - el.clientHeight > 4;
  const winScrolls = document.documentElement.scrollHeight - window.innerHeight > 4;
  if ((elScrolls && el.scrollTop < 80) || (winScrolls && window.scrollY < 80)) loadOlderMessages();
  const now = Date.now();
  const userDriven = now - lastUserScrollAt < 300 || now < momentumUntil;
  if (!isNearBottom()) {
    if (userDriven) {
      state.userScrolledAway = true;
      state.forceScrollCount = 0;
    }
  } else {
    // Always reset when we land at bottom — programmatic or not, we're caught up.
    state.userScrolledAway = false;
  }
}

/** Wheel/touch/key markers and the scroll-follow handler. */
export function wireScrollTracking(): void {
  window.addEventListener('wheel', markUserScroll, { passive: true });
  window.addEventListener(
    'touchstart',
    () => {
      touchMovedThisGesture = false;
    },
    { passive: true },
  );
  window.addEventListener(
    'touchmove',
    () => {
      touchMovedThisGesture = true;
      markUserScroll();
    },
    { passive: true },
  );
  window.addEventListener(
    'touchend',
    () => {
      if (touchMovedThisGesture) {
        momentumUntil = Date.now() + 1000;
      }
      touchMovedThisGesture = false;
    },
    { passive: true },
  );
  window.addEventListener('keydown', (e) => {
    // Skip when the user is typing into an input — space, arrows, home/end
    // are all editing keys there, not scroll intent.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'PageUp' ||
      e.key === 'PageDown' ||
      e.key === 'Home' ||
      e.key === 'End' ||
      e.key === ' '
    ) {
      markUserScroll();
    }
  });

  $('#messages')?.addEventListener('scroll', handleScroll);
  window.addEventListener('scroll', handleScroll);
}

export { setMessages } from './transcript-state.js';

// Clamp an a2a side-channel card to ~5 lines with a show more/less toggle.
// Must run AFTER the element is attached to the DOM (needs layout to measure).
export function applyA2aClamp(bubble: HTMLElement, container: HTMLElement) {
  bubble.classList.add('a2a-clamp', 'collapsed');
  // Fits within the clamp → no toggle needed; drop the clamp classes.
  if (bubble.scrollHeight <= bubble.clientHeight + 4) {
    bubble.classList.remove('a2a-clamp', 'collapsed');
    return;
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'a2a-more';
  toggle.textContent = 'Show more';
  toggle.addEventListener('click', () => {
    const collapsed = bubble.classList.toggle('collapsed');
    toggle.textContent = collapsed ? 'Show more' : 'Show less';
  });
  container.appendChild(toggle);
}
