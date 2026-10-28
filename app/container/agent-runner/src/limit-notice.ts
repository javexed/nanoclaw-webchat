/**
 * One usage-limit notice per conversation per reset.
 *
 * Several turns in one container can hit the same exhausted account at once:
 * queued follow-ups, or turns for different threads. Each used to post its own
 * limit notice, and its failed result then added "the agent run failed" on
 * top. Now a conversation (channel, room, thread) is told once per reset, and
 * until that reset a failure there adds nothing: the notice already said why.
 * A conversation that was not told yet, failing inside the window, gets the
 * limit notice instead of a generic failure, so it still learns when the
 * limit lifts (and a channel can still offer to retry then).
 *
 * State is per runner process, which is exactly the scope of the problem: one
 * container, one account. It is lost on respawn, at worst costing one repeat.
 */
import { LIMIT_RESETS_AT_FIELD, limitResetsAt } from './limit-reset.js';

/** How long a limit with no stated reset is assumed to last. */
const UNKNOWN_RESET_MS = 15 * 60_000;
/** Resets this close together are the same window, as reported by different turns. */
const SAME_RESET_MS = 5 * 60_000;

export interface LimitNotice {
  /** The chat content to write: text, plus the reset field when one is known. */
  content: Record<string, unknown>;
  /** The reset instant, ISO, or null when the provider gave none (or it is a credit limit). */
  resetsAt: string | null;
}

/** Conversation → the reset (ms) it was told about. */
const told = new Map<string, number>();
/** Until when this runner's account is known to be limited (ms). */
let limitedUntil = 0;
/** The latest notice, re-used for a conversation that fails inside the window untold. */
let lastNotice: LimitNotice | null = null;

/** The notice for a rate-limit or credit-limit error event. */
export function limitNotice(classification: 'rate_limit' | 'quota', message: string | undefined): LimitNotice {
  // A rate limit is TRANSIENT (it resets); credit exhaustion is not. Saying
  // "you may have run out of credits — check billing" for a rate limit is
  // alarming AND wrong, so the two read differently. The message carries the
  // reset/retry-after detail when the provider supplies one.
  if (classification === 'quota') {
    const text =
      "I've hit an API usage limit. You may have run out of credits on your Anthropic account — check console.anthropic.com/settings/billing.";
    return { content: { text }, resetsAt: null };
  }
  const resetDetail = /\((?:resets|retry after)[^)]*\)/.exec(message || '')?.[0];
  const text = `I've hit the API rate limit — it's temporary and resets on its own${resetDetail ? ` ${resetDetail}` : ''}. Send that again in a bit and I'll pick it up.`;
  // The reset as a field too, for a channel that offers to retry then.
  const resetsAt = limitResetsAt(message);
  return { content: resetsAt ? { text, [LIMIT_RESETS_AT_FIELD]: resetsAt } : { text }, resetsAt };
}

/** The conversation a route belongs to: one room thread on one channel. */
export function conversationOf(routing: {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}): string {
  return `${routing.channelType ?? ''}:${routing.platformId ?? ''}:${routing.threadId ?? ''}`;
}

function prune(now: number): void {
  for (const [key, until] of told) if (until <= now) told.delete(key);
}

/**
 * Record a limit hit in `conversation`. True when the notice should be posted;
 * false when this conversation was already told about this window.
 */
export function noteLimit(conversation: string, notice: LimitNotice, now = Date.now()): boolean {
  prune(now);
  const parsed = notice.resetsAt ? Date.parse(notice.resetsAt) : NaN;
  const known = Number.isFinite(parsed);
  const resetsAt = known ? parsed : now + UNKNOWN_RESET_MS;
  limitedUntil = Math.max(limitedUntil, resetsAt);
  lastNotice = notice;
  const prior = told.get(conversation);
  // Told already, and this is the same window: an unknown reset, or one close
  // to the reset it was told. A later window is news.
  if (prior !== undefined && (!known || Math.abs(prior - resetsAt) <= SAME_RESET_MS)) return false;
  told.set(conversation, resetsAt);
  return true;
}

/**
 * A failure in `conversation` while the account is limited. 'told': it was
 * already told, so say nothing more. A notice: tell it about the limit
 * instead of the failure (and record that it was told). null: no limit is
 * known right now, so the failure notice stands.
 */
export function limitCoversFailure(conversation: string, now = Date.now()): 'told' | LimitNotice | null {
  if (now >= limitedUntil || !lastNotice) return null;
  prune(now);
  if (told.has(conversation)) return 'told';
  told.set(conversation, limitedUntil);
  return lastNotice;
}

/** Forget every recorded limit (tests). */
export function resetLimitNotices(): void {
  told.clear();
  limitedUntil = 0;
  lastNotice = null;
}
