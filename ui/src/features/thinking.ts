// ── Thinking bubbles + reasoning feed ────────────────────────────────────────
// The live "what is the agent doing" surface: the bubble with a verb, target
// and milestone lines, the streaming reasoning feed, and the collapsed
// "Thoughts (N)" disclosure folded onto the finished reply.
//
// DEPENDENCY INJECTION, not imports, for the five transcript helpers this needs
// (bubbleFor, interruptAgent, isNearBottom, renderFullTrace, scrollToBottom).
// They still live in legacy.js, which imports THIS module — importing back
// would form a cycle through a 19k-line module with top-level side effects, and
// the evaluation order of that is not something to rely on. legacy calls
// provideThinkingDeps() once at startup instead. When transcript/ is extracted
// these become ordinary imports and the injection goes away.
import { $, lucideEl } from '../core/dom.js';
import { isAdminView, isForcedScroll, state } from '../core/state.js';
// Injected until phase 1g. transcript owns these now, so they are real edges.
// The reverse edge (buildThoughtsDisclosure) is INJECTED into transcript rather
// than imported, so the dependency stays one-way and no cycle forms.
import { isNearBottom, scrollToBottom } from './transcript.js';
import { nextKey, thinkingTurns, turnFor } from './transcript-state.js';
import type { ThinkingTurn } from './transcript-state.js';

/**
 * What features/thinking needs that it does not own. interruptAgent still lives
 * in legacy; isForcedScroll is a read-only view onto legacy's scroll counters.
 * Everything else it once needed became a real import from features/transcript
 * in phase 1g.
 */
// The per-turn state that used to hang off the bubble ELEMENT as `_turn`, and
// the feed line's `_fadeTimer` with it, now live in transcript-state.ts — a
// turn outlives no DOM node, so there is nothing to hang them on.

export interface ThinkingDeps {
  interruptAgent: (name: string) => void;
}

const deps = {} as ThinkingDeps;

/** Wire the transcript helpers this module calls. Call once, before any turn. */
export function provideThinkingDeps(provided: Partial<ThinkingDeps>): void {
  Object.assign(deps, provided);
}

// Collapsible "Thoughts" disclosure folded onto an agent reply — the full
// reasoning trace captured during the turn. Collapsed by default, but the summary
// carries a muted preview of the latest line so there's visible detail without
// expanding (CSS hides the preview once the disclosure is open).
const THINKING_DETAIL_MAX = 64; // truncate the target line (file/command/query)
const REASONING_LOG_MAX = 500; // cap a single agent's retained reasoning lines
// Ensure the thinking bubble exists and is laid out with: a verb in the sender
// line, a target line (the file/command/query), a milestone line (latest
// progress), and the animated dots. Shared with the heartbeat typing path —
// both create-or-reuse the single `.thinking-bubble`, so activity persists
// through the turn and clears when the agent's message lands.
/**
 * Create-or-reuse the turn for one agent. Shared with the heartbeat typing
 * path, so activity persists through the turn and clears when the reply lands.
 */
function ensureTurn(name?: string): ThinkingTurn {
  const key = name || state.agentName || 'Agent';
  const existing = turnFor(key);
  if (existing) return existing;
  // Same shouldScroll formula as the 'message' handler — honours
  // forceScrollCount so the bubble follows even mid smooth-scroll.
  const shouldScroll = isNearBottom() || isForcedScroll();
  const now = Date.now();
  thinkingTurns.value = [
    ...thinkingTurns.value,
    {
      name: key,
      startedAt: now,
      lastActivityAt: now,
      verb: 'Thinking',
      detail: null,
      milestone: null,
      reasoningLog: [],
      feed: [],
      expanded: false,
      elapsed: '',
      statusLive: false,
    },
  ];
  if (shouldScroll) scrollToBottom();
  return turnFor(key)!;
}

/** Click toggles the full reasoning trace. The trace rebuilds from reasoningLog
 *  on every render, so there is nothing to re-render by hand. */
function toggleThinkingExpanded(name: string) {
  const turn = turnFor(name);
  if (turn) turn.expanded = !turn.expanded;
}

function updateThinkingBubble(name: string, label: string, detail?: string) {
  const turn = ensureTurn(name);
  turn.verb = label;
  // The target line keeps its LAST text when detail is absent: the imperative
  // version only flipped `hidden`, it never cleared textContent.
  if (detail) {
    turn.detail =
      detail.length > THINKING_DETAIL_MAX ? `${detail.slice(0, THINKING_DETAIL_MAX - 1)}…` : detail;
  } else if (turn.detail) {
    turn.detail = null;
  }
}

function setThinkingMilestone(name: string, text: string) {
  ensureTurn(name).milestone = text;
}

const REASONING_FEED_BUFFER = 40; // max lines kept in the feed (scroll history)
const REASONING_FEED_TTL = 7000; // ms a line lingers before it fades out
const REASONING_FADE_MS = 500; // fade-out transition duration (matches CSS)
// Append one reasoning line to the bubble's feed. The feed is a fixed-height
// window (CSS max-height + overflow): new lines land at the bottom and the
// window auto-scrolls to follow, so longer reasoning scrolls upward and fades
// under the top gradient mask. Each line also self-fades after REASONING_FEED_TTL
// so the feed drains when reasoning pauses; the whole thing clears with the
// bubble when the agent's message lands. A bounded DOM buffer caps memory.
function pushReasoning(name: string, text: string) {
  const turn = ensureTurn(name);

  // Retain the full line for the click-to-expand view and the reply disclosure.
  turn.reasoningLog.push(text);
  if (turn.reasoningLog.length > REASONING_LOG_MAX) turn.reasoningLog.shift();

  // The feed is a BOUNDED TAIL, not a slice of reasoningLog: lines fade out on
  // their own timer and the buffer is trimmed independently of the log, which
  // is why both exist.
  const line = { key: nextKey(), text, fading: false };
  turn.feed.push(line);
  while (turn.feed.length > REASONING_FEED_BUFFER) {
    const oldest = turn.feed.shift();
    if (oldest && feedTimers.has(oldest.key)) {
      clearTimeout(feedTimers.get(oldest.key)!);
      feedTimers.delete(oldest.key);
    }
  }

  feedTimers.set(
    line.key,
    setTimeout(() => {
      feedTimers.delete(line.key);
      const l = turn.feed.find((x) => x.key === line.key);
      if (l) l.fading = true;
      setTimeout(() => {
        const i = turn.feed.findIndex((x) => x.key === line.key);
        if (i !== -1) turn.feed.splice(i, 1);
      }, REASONING_FADE_MS);
    }, REASONING_FEED_TTL),
  );

  const shouldScroll = isNearBottom() || isForcedScroll();
  if (shouldScroll) scrollToBottom();
}

/** Per-line fade timers, keyed by feed-line key. These hung off the DOM node as
 *  `_fadeTimer`; a row has nowhere to hang them, and they must still be
 *  cancellable when the buffer trims a line early. */
const feedTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** Drop a finished turn — its bubble and elapsed timer go with it. */
export function removeTurn(name: string): void {
  const turn = turnFor(name);
  if (turn) for (const l of turn.feed) {
    const t = feedTimers.get(l.key);
    if (t) clearTimeout(t);
    feedTimers.delete(l.key);
  }
  thinkingTurns.value = thinkingTurns.value.filter((t) => t.name !== name);
}

export { ensureTurn, updateThinkingBubble, setThinkingMilestone, pushReasoning, toggleThinkingExpanded };

export function applyMarketplaceNav() {
  const show = state.marketplaceEnabled && isAdminView.value;
  for (const id of ['#overflow-mcp', '#mtab-mcp-btn', '#mtab-skills-btn', '#overflow-skills']) {
    const el = $(id);
    if (el) el.hidden = !show;
  }
}
