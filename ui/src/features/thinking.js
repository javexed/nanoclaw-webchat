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

/** @type {Record<string, Function>} */
const deps = {};

/** Wire the transcript helpers this module calls. Call once, before any turn. */
export function provideThinkingDeps(provided) {
  Object.assign(deps, provided);
}

function buildThoughtsDisclosure(lines) {
  const details = document.createElement('details');
  details.className = 'thoughts';
  const summary = document.createElement('summary');
  summary.appendChild(lucideEl('sparkles'));
  summary.append(` Thoughts (${lines.length})`);
  const last = lines[lines.length - 1] || '';
  if (last) {
    const preview = document.createElement('span');
    preview.className = 'thoughts-preview';
    preview.textContent = ' — ' + (last.length > 90 ? `${last.slice(0, 89)}…` : last);
    summary.appendChild(preview);
  }
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'thoughts-body';
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'thoughts-line';
    row.textContent = line;
    body.appendChild(row);
  }
  details.appendChild(body);
  return details;
}
const THINKING_DETAIL_MAX = 64; // truncate the target line (file/command/query)
const REASONING_LOG_MAX = 500; // cap a single agent's retained reasoning lines
function ensureThinkingBubble(name) {
  const key = name || deps.getAgentName() || 'Agent';
  let bubble = deps.bubbleFor(key);
  if (bubble) return bubble;
  // Same shouldScroll formula as the 'message' handler — honors forceScrollCount
  // so the bubble follows even when a smooth scroll is still mid-animation.
  const shouldScroll = deps.isNearBottom() || deps.isForcedScroll();
  bubble = document.createElement('div');
  bubble.className = 'msg agent thinking-bubble';
  bubble.dataset.agent = key; // one bubble per agent, keyed by name
  bubble._turn = { startedAt: Date.now(), lastActivityAt: Date.now(), reasoningLog: [] };
  // Sender line: icon + "{agent} — " + a verb span (refined by tool events) +
  // an elapsed span (ticked while the turn is active). Verb/elapsed live in
  // their own spans so each updates without clobbering the other.
  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.appendChild(lucideEl('bot'));
  sender.appendChild(document.createTextNode(` ${key} — `));
  const verb = document.createElement('span');
  verb.className = 'thinking-verb';
  verb.textContent = 'Thinking';
  sender.appendChild(verb);
  const elapsed = document.createElement('span');
  elapsed.className = 'thinking-elapsed';
  sender.appendChild(elapsed);
  // Chevron affordance — the bubble is click-to-expand into the full trace.
  const chevron = document.createElement('span');
  chevron.className = 'thinking-chevron';
  chevron.appendChild(lucideEl('chevron-right'));
  sender.appendChild(chevron);
  // Stop button — interrupt the in-progress turn (the GUI equivalent of CLI ESC).
  // stopPropagation so it doesn't also fire the bubble's expand-toggle handler.
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'thinking-stop';
  stop.title = 'Stop the agent';
  stop.setAttribute('aria-label', 'Stop the agent');
  stop.innerHTML = '<span class="stop-square" aria-hidden="true"></span>Stop';
  stop.addEventListener('click', (e) => {
    e.stopPropagation();
    deps.interruptAgent(key);
  });
  sender.appendChild(stop);
  bubble.appendChild(sender);
  const content = document.createElement('div');
  content.className = 'bubble';
  // .thinking-feed = compact fading window (collapsed view); .thinking-fulltrace
  // = the whole turn's reasoning, scrollable (expanded view). CSS swaps them on
  // the bubble's .expanded class.
  content.innerHTML =
    '<div class="thinking-milestone" hidden></div>' +
    '<div class="thinking-target" hidden></div>' +
    '<div class="thinking-feed" hidden></div>' +
    '<div class="thinking-fulltrace"></div>' +
    '<span class="dots"><span></span><span></span><span></span></span>';
  bubble.appendChild(content);
  // Click toggles the full reasoning trace. Ignore clicks on links/buttons so
  // selecting text or tapping a link inside doesn't toggle.
  bubble.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    toggleThinkingExpanded(bubble);
  });
  $('#messages').appendChild(bubble);
  if (shouldScroll) deps.scrollToBottom();
  return bubble;
}
function toggleThinkingExpanded(bubble) {
  const expanded = bubble.classList.toggle('expanded');
  if (expanded) deps.renderFullTrace(bubble);
}
function updateThinkingBubble(name, label, detail) {
  const bubble = ensureThinkingBubble(name);
  const verbEl = bubble.querySelector('.thinking-verb');
  if (verbEl) verbEl.textContent = label;
  const target = bubble.querySelector('.thinking-target');
  if (target) {
    if (detail) {
      const trimmed = detail.length > THINKING_DETAIL_MAX ? `${detail.slice(0, THINKING_DETAIL_MAX - 1)}…` : detail;
      target.textContent = trimmed;
      target.hidden = false;
    } else {
      target.hidden = true;
    }
  }
}
function setThinkingMilestone(name, text) {
  const bubble = ensureThinkingBubble(name);
  const el = bubble.querySelector('.thinking-milestone');
  if (el) {
    el.textContent = text;
    el.hidden = false;
  }
}
const REASONING_FEED_BUFFER = 40; // max lines kept in the DOM (scroll history)
const REASONING_FEED_TTL = 7000; // ms a line lingers before it fades out
const REASONING_FADE_MS = 500; // fade-out transition duration (matches CSS)
// Append one reasoning line to the bubble's feed. The feed is a fixed-height
// window (CSS max-height + overflow): new lines land at the bottom and the
// window auto-scrolls to follow, so longer reasoning scrolls upward and fades
// under the top gradient mask. Each line also self-fades after REASONING_FEED_TTL
// so the feed drains when reasoning pauses; the whole thing clears with the
// bubble when the agent's message lands. A bounded DOM buffer caps memory.
function pushReasoning(name, text) {
  const bubble = ensureThinkingBubble(name);
  if (!bubble._turn) bubble._turn = { startedAt: Date.now(), lastActivityAt: Date.now(), reasoningLog: [] };

  // Retain the full line for the click-to-expand view and the reply disclosure.
  bubble._turn.reasoningLog.push(text);
  if (bubble._turn.reasoningLog.length > REASONING_LOG_MAX) bubble._turn.reasoningLog.shift();
  // If the user is currently viewing the expanded trace, keep it live.
  if (bubble.classList.contains('expanded')) deps.renderFullTrace(bubble);

  const feed = bubble.querySelector('.thinking-feed');
  if (!feed) return;
  feed.hidden = false;

  const line = document.createElement('div');
  line.className = 'thinking-feed-line';
  line.textContent = text;
  feed.appendChild(line);

  // Trim the DOM buffer — drop the oldest (already scrolled out of view),
  // cancelling its pending fade timer so it can't fire after removal.
  while (feed.children.length > REASONING_FEED_BUFFER) {
    const oldest = feed.firstChild;
    if (oldest._fadeTimer) clearTimeout(oldest._fadeTimer);
    feed.removeChild(oldest);
  }

  // Follow the newest line within the feed's own scroll viewport.
  feed.scrollTop = feed.scrollHeight;

  line._fadeTimer = setTimeout(() => {
    line.classList.add('fading');
    setTimeout(() => {
      line.remove();
      if (feed.children.length === 0) feed.hidden = true;
    }, REASONING_FADE_MS);
  }, REASONING_FEED_TTL);

  const shouldScroll = deps.isNearBottom() || deps.isForcedScroll();
  if (shouldScroll) deps.scrollToBottom();
}
export {
  buildThoughtsDisclosure, ensureThinkingBubble, updateThinkingBubble,
  setThinkingMilestone, pushReasoning,
};
