/**
 * The approval card in the room that asked for it, through its whole life:
 *
 *   pending   → actionable for the people who may approve it (the client
 *               matches its user id against `approvers`), read-only
 *               "Waiting for <name>" for everyone else;
 *   reminder  → a notice ~1 hour before it expires;
 *   resolved  → approved (with the result's one-line summary and redacted
 *               Details), rejected, or expired;
 *   expired   → a notice at the bottom of the room that says so plainly, with
 *               "Send again" re-issuing the identical request (resend.ts).
 *
 * Card rows are `appr-card-<approvalId>`; notices `appr-notice-<kind>-<approvalId>`,
 * so every write is idempotent and a re-broadcast replaces the row in place.
 */
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getExpiredPendingApprovals } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { ApprovalResolvedEvent } from '../../modules/approvals/primitive.js';
import { approvalTtlMs, EXPIRY_USER, ttlWords } from '../../modules/approvals/expiry.js';
import { approverLabel, personName, takeApprovedOutcome } from '../../modules/approvals/words.js';
import { getUser } from '../../modules/permissions/db/users.js';
import { canAccessRoom } from './access.js';
import { rowToMessage, type WebchatMessage, type WebchatMessageRow } from './db.js';

/** How long before expiry the room is reminded. */
export const REMIND_BEFORE_MS = 60 * 60 * 1000;

export const cardId = (approvalId: string): string => `appr-card-${approvalId}`;
export const noticeId = (kind: NoticeKind, approvalId: string): string => `appr-notice-${kind}-${approvalId}`;

export type NoticeKind = 'reminder' | 'expired';

/** What a notice row carries. `text` is the whole message, for push and search too. */
export interface ApprovalNotice {
  questionId: string;
  kind: NoticeKind;
  title: string;
  text: string;
  /** On an expired notice once someone sent it again. */
  resentBy?: string;
  resentByName?: string;
}

async function messageRow(id: string): Promise<WebchatMessage | undefined> {
  const row = (await getDb().get(`SELECT * FROM webchat_messages WHERE id = ?`, id)) as WebchatMessageRow | undefined;
  return row ? rowToMessage(row) : undefined;
}

function parse(content: string): Record<string, unknown> {
  try {
    const v = JSON.parse(content) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The card row of an approval, if it was shown in a room. */
export async function getApprovalCard(approvalId: string): Promise<WebchatMessage | undefined> {
  return messageRow(cardId(approvalId));
}

/** Merge fields into a card's content (and optionally its type); returns the updated row. */
export async function patchApprovalCard(
  approvalId: string,
  patch: Record<string, unknown>,
  messageType?: 'approval' | 'approval_resolved',
): Promise<WebchatMessage | undefined> {
  const card = await getApprovalCard(approvalId);
  if (!card) return undefined;
  const content = JSON.stringify({ ...parse(card.content), ...patch });
  await getDb().run(
    `UPDATE webchat_messages SET content = ?, message_type = ? WHERE id = ?`,
    content,
    messageType ?? card.message_type,
    card.id,
  );
  return { ...card, content, message_type: messageType ?? card.message_type };
}

/** Store a notice next to a card (idempotent per kind). Returns it, or null if it already existed. */
export async function storeApprovalNotice(
  card: Pick<WebchatMessage, 'room_id' | 'thread_id' | 'sender'>,
  notice: ApprovalNotice,
  now = Date.now(),
): Promise<WebchatMessage | null> {
  const msg: WebchatMessage = {
    id: noticeId(notice.kind, notice.questionId),
    room_id: card.room_id,
    thread_id: card.thread_id,
    sender: card.sender,
    sender_type: 'agent',
    content: JSON.stringify(notice),
    message_type: 'approval_notice',
    file_meta: null,
    created_at: now,
  };
  const r = await getDb().run(
    `INSERT OR IGNORE INTO webchat_messages (id, room_id, thread_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @thread_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    { ...msg, file_meta: null },
  );
  return (r.changes ?? 0) > 0 ? msg : null;
}

/** Mark the expired notice as sent again; returns the updated row. */
export async function markNoticeResent(approvalId: string, byUserId: string): Promise<WebchatMessage | undefined> {
  const n = await messageRow(noticeId('expired', approvalId));
  if (!n) return undefined;
  const content = JSON.stringify({ ...parse(n.content), resentBy: byUserId, resentByName: await personName(byUserId) });
  await getDb().run(`UPDATE webchat_messages SET content = ? WHERE id = ?`, content, n.id);
  return { ...n, content };
}

/** May this user send an expired request again? Anyone who can see the room it was asked in. */
export async function canResendApproval(userId: string, approvalId: string): Promise<boolean> {
  const card = await getApprovalCard(approvalId);
  return !!card && (await canAccessRoom(userId, card.room_id));
}

/**
 * The card's fields that say who may approve it and until when. A client knows
 * its viewer by identity (the name it signed in with), never by user id, so
 * the card carries its approvers' identities for the client to match.
 */
export async function cardAudience(approvers: string[], createdAt = Date.now()) {
  const ttl = approvalTtlMs();
  return {
    approverNames: await Promise.all(approvers.map(approverLabel)),
    approverIdentities: await Promise.all(
      approvers.map(async (a) => (await getUser(a).catch(() => undefined))?.display_name || a.split(':').pop() || a),
    ),
    ...(ttl > 0 ? { expiresAt: createdAt + ttl } : {}),
  };
}

/**
 * The card's resolved state for a resolution event: who, which way, and for an
 * approval that ran, its one-line outcome and redacted details.
 */
export async function resolvedPatch(event: ApprovalResolvedEvent): Promise<Record<string, unknown>> {
  if (event.userId === EXPIRY_USER) return { resolvedBy: EXPIRY_USER, outcome: 'expired' };
  const patch: Record<string, unknown> = {
    resolvedBy: event.userId,
    resolvedByName: event.userId ? await personName(event.userId) : '',
    outcome: event.outcome === 'approve' ? 'approved' : 'rejected',
  };
  const result = event.outcome === 'approve' ? takeApprovedOutcome(event.approval.approval_id) : undefined;
  if (result) patch.result = result;
  return patch;
}

/** The notice posted when a card expires. */
export function expiredNotice(approvalId: string, title: string): ApprovalNotice {
  return {
    questionId: approvalId,
    kind: 'expired',
    title,
    text: `Approval for "${title}" expired: nobody answered within ${ttlWords()}, so it didn't run.`,
  };
}

/**
 * Remind each room whose card expires within the hour, once. Returns the
 * notices posted, for the caller to broadcast.
 */
export async function sweepApprovalReminders(now = Date.now()): Promise<WebchatMessage[]> {
  const ttl = approvalTtlMs();
  // A TTL of two hours or less has no meaningful "one hour left".
  if (ttl <= 2 * REMIND_BEFORE_MS) return [];
  const posted: WebchatMessage[] = [];
  for (const approval of await getExpiredPendingApprovals(now - (ttl - REMIND_BEFORE_MS))) {
    try {
      const card = await getApprovalCard(approval.approval_id);
      if (!card || card.message_type !== 'approval') continue;
      const c = parse(card.content);
      const title = String(c.title || approval.title || 'Approval');
      const names = Array.isArray(c.approverNames) ? (c.approverNames as string[]) : [];
      const waiting = names.length
        ? ` Waiting for ${names.map((n) => n.replace(/ \((owner|admin)\)$/, '')).join(' or ')}.`
        : '';
      const notice = await storeApprovalNotice(
        card,
        {
          questionId: approval.approval_id,
          kind: 'reminder',
          title,
          text: `Approval for "${title}" expires in 1 hour.${waiting}`,
        },
        now,
      );
      if (notice) posted.push(notice);
    } catch (err) {
      log.warn('Approval reminder failed', { approvalId: approval.approval_id, err: String(err) });
    }
  }
  return posted;
}

/**
 * The approvers who can act on a card in this conversation: for a webchat
 * room, those who can open the room. null for any other conversation.
 */
export async function approversInRoom(messagingGroupId: string, approvers: string[]): Promise<string[] | null> {
  const mg = await getMessagingGroup(messagingGroupId);
  if (!mg || mg.channel_type !== 'webchat') return null;
  const here: string[] = [];
  for (const a of approvers) if (await canAccessRoom(a, mg.platform_id)) here.push(a);
  return here;
}
