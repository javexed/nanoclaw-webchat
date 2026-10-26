/**
 * When a rate limit lifts, as a field on the notice the runner writes for it.
 *
 * The notice is chat text for every channel; a channel that can offer "retry
 * then" needs the instant itself, not a sentence to re-parse. The provider puts
 * it in the error message as "(resets <ISO>)" (claude.ts classifyRateLimitEvent).
 * No reset in the message, or one that does not parse, gives null: the notice
 * then carries no field and a channel offers nothing.
 */
export const LIMIT_RESETS_AT_FIELD = 'limitResetsAt';

export function limitResetsAt(message: string | undefined): string | null {
  const m = /\(resets ([^)]+)\)/.exec(message ?? '');
  if (!m) return null;
  const t = Date.parse(m[1]!);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
