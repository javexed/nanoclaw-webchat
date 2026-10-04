// ── Thinking bubbles + reasoning feed ────────────────────────────────────────
// The live "what is the agent doing" surface: the bubble with a verb, target
// and milestone lines, the streaming reasoning feed, and the collapsed
// "Thoughts (N)" disclosure folded onto the finished reply.
import { $ } from '../core/dom.js';
import { isAdminView, isForcedScroll, state } from '../core/state.js';
// The reverse edge (toggleThinkingExpanded) is INJECTED into transcript rather
// than imported, so the dependency stays one-way and no cycle forms.
import { isNearBottom, scrollToBottom } from './transcript.js';
import { nextKey, thinkingTurns, turnFor } from './transcript-state.js';
import type { ThinkingTurn } from './transcript-state.js';

const THINKING_DETAIL_MAX = 64; // truncate the target line (file/command/query)
const REASONING_LOG_MAX = 500; // cap a single agent's retained reasoning lines
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
      fullTrace: [],
      feed: [],
      tools: [],
      notes: [],
      meta: null,
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
  // The target line keeps its LAST text when detail is absent (only hidden flips).
  if (detail) {
    turn.detail =
      detail.length > THINKING_DETAIL_MAX ? `${detail.slice(0, THINKING_DETAIL_MAX - 1)}…` : detail;
  } else if (turn.detail) {
    turn.detail = null;
  }
}

function setThinkingMilestone(name: string, text: string) {
  const turn = ensureTurn(name);
  closeOpenTool(turn);
  turn.milestone = text;
  pushNote(turn, 'progress', text);
}

const TURN_TOOLS_MAX = 300;
const TURN_NOTES_MAX = 100;

/** A tool runs until the next activity: that is when its time is known. */
function closeOpenTool(turn: ThinkingTurn, now = Date.now()): void {
  const last = turn.tools[turn.tools.length - 1];
  if (last && last.ms === null) last.ms = Math.max(0, now - last.at);
}

function pushNote(turn: ThinkingTurn, kind: string, text: string): void {
  if (turn.notes.length < TURN_NOTES_MAX) turn.notes.push({ kind, text });
}

/** Record a tool call for the expanded bubble and the reply's Thoughts. */
function pushTool(name: string, tool: string, target: string | null) {
  const turn = ensureTurn(name);
  closeOpenTool(turn);
  if (turn.tools.length < TURN_TOOLS_MAX) turn.tools.push({ name: tool, target, at: Date.now(), ms: null });
}

/** Harness · model · host for the turn, from the server's `turn_meta` frame. */
function setTurnMeta(name: string, meta: { harness: string | null; model: string | null; host: string | null }) {
  ensureTurn(name).meta = meta;
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
function pushReasoning(name: string, text: string, full?: string) {
  const turn = ensureTurn(name);
  closeOpenTool(turn);

  // Retain the clipped line for the feed and the reply disclosure.
  turn.reasoningLog.push(text);
  if (turn.reasoningLog.length > REASONING_LOG_MAX) turn.reasoningLog.shift();

  // The untruncated block rides `detail` on the FIRST line of each thinking
  // block (see claude.ts). It is what click-to-expand shows: reasoningLog is
  // capped at 8 lines x 200 chars per block by summarizeThinking, so it would
  // only repeat the clipped text the feed already showed.
  if (full) {
    turn.fullTrace.push(full);
    if (turn.fullTrace.length > REASONING_LOG_MAX) turn.fullTrace.shift();
  }

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

/** Per-line fade timers, keyed by feed-line key — cancellable when the buffer
 *  trims a line early. */
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

export {
  ensureTurn,
  updateThinkingBubble,
  setThinkingMilestone,
  pushReasoning,
  pushTool,
  setTurnMeta,
  toggleThinkingExpanded,
};

// Show/hide the MCP + Skills nav for the current session (admin AND enabled).
export function applyMarketplaceNav() {
  const show = state.marketplaceEnabled && isAdminView.value;
  for (const id of ['#overflow-mcp', '#mtab-mcp-btn', '#mtab-skills-btn', '#overflow-skills']) {
    const el = $(id);
    if (el) el.hidden = !show;
  }
}
