/**
 * What the room shows for an approval card and its notices, decided from the
 * stored row and who is looking. Pure, so the states are testable:
 *
 *   eligible  — the viewer may approve it: the full card with its actions
 *   awaiting  — anyone else: "Waiting for <name>"
 *   approved / rejected / expired — the outcome, with the result's summary
 *   resolved  — an older row that recorded only who resolved it
 */

export type RoomApprovalState = 'eligible' | 'awaiting' | 'approved' | 'rejected' | 'expired' | 'resolved';

export interface ApprovalOutcomeView {
  line: string;
  details: string;
  failed: boolean;
}

export interface RoomApprovalView {
  questionId: string;
  state: RoomApprovalState;
  /** The one-line note for every state but `eligible`. */
  note: string;
  /** An approval that ran: its summary and redacted details. */
  result: ApprovalOutcomeView | null;
  /** The card's own fields, for the actionable form. */
  card: { questionId: string; title?: string; payload?: unknown; options?: unknown };
}

export interface ApprovalNoticeView {
  questionId: string;
  kind: 'reminder' | 'expired';
  text: string;
  /** Who sent an expired request again, once someone has. */
  resentByName: string | null;
}

function parse(content: unknown): Record<string, any> {
  if (content && typeof content === 'object') return content as Record<string, any>;
  try {
    const v = JSON.parse(String(content ?? '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** The short name of a user id: "webchat:tailscale:bob@x.com" → "bob". */
export function shortName(userId: unknown): string {
  return (
    String(userId ?? '')
      .split(':')
      .pop() ?? ''
  ).split('@')[0];
}

/** Names without their "(owner)"/"(admin)" role, joined with "or". */
function waitingFor(names: unknown): string {
  const list = Array.isArray(names) ? names.map((n) => String(n).replace(/ \((owner|admin)\)$/, '')) : [];
  return list.length ? list.join(' or ') : 'an admin';
}

/**
 * May this viewer act on the card? The client knows its viewer by identity
 * (the name it signed in with), so the card lists its approvers' identities;
 * a card stored before that matches the identity its approver ids end with.
 * The server checks every click either way.
 */
export function canActOn(approvers: unknown, identities: unknown, myIdentity: string): boolean {
  if (!myIdentity) return false;
  if (Array.isArray(identities) && identities.includes(myIdentity)) return true;
  return Array.isArray(approvers) && approvers.some((a) => String(a).split(':').pop() === myIdentity);
}

export function roomApprovalView(
  msg: { id?: string; content?: unknown; message_type?: string },
  myIdentity: string,
): RoomApprovalView {
  const data = parse(msg.content);
  const questionId = String(data.questionId || msg.id || '');
  const title = String(data.title || 'Approval');
  const card = { questionId, title: data.title, payload: data.question, options: data.options };
  const resolved = msg.message_type === 'approval_resolved' || !!data.resolvedBy;
  const by = String(data.resolvedByName || shortName(data.resolvedBy));
  // `outcome` is the line without "Approved…" (the note already says it); older rows have only `line`.
  const r = data.result;
  const line = r && typeof r.outcome === 'string' ? r.outcome : r && typeof r.line === 'string' ? r.line : null;
  const result = line !== null ? { line, details: String(r.details || ''), failed: !!r.failed } : null;
  if (resolved) {
    if (data.outcome === 'expired')
      return { questionId, state: 'expired', note: `⏱ ${title} — expired`, result: null, card };
    if (data.outcome === 'approved')
      return { questionId, state: 'approved', note: `✅ ${title} — approved${by ? ` by ${by}` : ''}`, result, card };
    if (data.outcome === 'rejected')
      return {
        questionId,
        state: 'rejected',
        note: `❌ ${title} — rejected${by ? ` by ${by}` : ''}`,
        result: null,
        card,
      };
    return {
      questionId,
      state: 'resolved',
      note: `🔒 ${title} — resolved${by ? ` by ${by}` : ''}`,
      result: null,
      card,
    };
  }
  if (canActOn(data.approvers, data.approverIdentities, myIdentity))
    return { questionId, state: 'eligible', note: '', result: null, card };
  return {
    questionId,
    state: 'awaiting',
    note: `🔒 ${title} — waiting for ${waitingFor(data.approverNames)}`,
    result: null,
    card,
  };
}

export function approvalNoticeView(msg: { content?: unknown }): ApprovalNoticeView {
  const data = parse(msg.content);
  return {
    questionId: String(data.questionId || ''),
    kind: data.kind === 'expired' ? 'expired' : 'reminder',
    text: String(data.text || ''),
    resentByName: data.resentBy ? String(data.resentByName || shortName(data.resentBy)) : null,
  };
}
