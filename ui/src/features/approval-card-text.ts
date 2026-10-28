/**
 * What an approval card shows: the card's own text first, the raw request
 * behind a collapsed Details. The pending list carries the text as `question`;
 * an in-room card carries it there too, and older rows may carry it only as a
 * string payload.
 */
export interface ApprovalText {
  question?: unknown;
  payload?: unknown;
}

/** The text the approver reads, or '' when the card has none. */
export function approvalCardText(a: ApprovalText): string {
  if (typeof a.question === 'string' && a.question) return a.question;
  return typeof a.payload === 'string' ? a.payload : '';
}

/** The raw request for the Details block, or null when it adds nothing beyond the text. */
export function approvalRawPayload(a: ApprovalText): unknown {
  const p = a.payload;
  if (p === undefined || p === null || p === '') return null;
  if (typeof p === 'string') return approvalCardText(a) === p ? null : p;
  return p;
}
