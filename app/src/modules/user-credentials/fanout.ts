/**
 * UserCreds shared-context fan-out.
 *
 * On a per-member session's wake turn, write the full recent room transcript
 * into that member's session — the current message as the wake (trigger=1), the
 * rest as context (trigger=0) — so the responding agent always has the whole
 * conversation, even though each member runs in their own container. Idle
 * members catch up the same way when they next speak.
 *
 * Stable ids `user-creds-<session>-<roomMsgId>` make this idempotent: re-syncing each
 * turn only adds genuinely new messages. Content matches the webchat inbound
 * shape ({text, sender, senderName}) so the agent-runner formats it identically.
 *
 * BLAST RADIUS (by design): in a SHARED UserCreds room, every connected member's
 * own container receives the full room transcript — i.e. each member's container
 * is a read surface for all members' message *content* (never their
 * credentials — keys never cross containers). This is the price of giving each
 * per-member agent full conversational context in a shared room. It is NOT a
 * fit for rooms whose members shouldn't see each other's messages; for that,
 * use separate (non-shared) agent groups or per-member rooms. Credential
 * isolation is unaffected — only transcript content fans out.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getWebchatMessages, type WebchatMessage } from '../../channels/webchat/db.js';
import { memberThreadFromKey } from './identity.js';
import { uploadsDir } from '../../channels/webchat/files.js';
import { syncSessionContext, type ContextMessage, type SessionInboundWriterArgs } from '../../session-manager.js';
import { log } from '../../log.js';

const TRANSCRIPT_LIMIT = 60;
// Side-channel rows (a2a copies, approval cards) are not conversation turns.
const SKIP_TYPES = new Set(['a2a', 'approval', 'approval_resolved']);

// Only the turn's own file is inlined as base64. Historical file rows get a
// text marker instead: syncSessionContext skips ids it has already written, so
// re-encoding every past upload on every turn would be pure waste — and a
// 60-message transcript of large files would dwarf the turn itself.
// `extractAttachmentFiles` stages `data` only (it ignores `hostPath`), so a
// file above this cap can only be described, not delivered.
const INLINE_ATTACHMENT_CAP = 25 * 1024 * 1024;

/**
 * Build the inbound content for one transcript row.
 *
 * A file row's `content` column holds only the caption — the bytes live in
 * `file_meta`. Serialising `content` alone (as this did before) handed the
 * agent `{"text":""}` for every upload: no text, no attachment, nothing to act
 * on. Mark hit exactly that — 21 uploads in a row arrived blank.
 */
function contentFor(m: WebchatMessage, roomId: string, isCurrent: boolean): string {
  const base = { sender: m.sender, senderName: m.sender, senderId: '' };
  const fm = m.file_meta;
  if (!fm) return JSON.stringify({ text: m.content, ...base });

  const marker = `[File: ${fm.filename} (${fm.mime}, ${fm.size} bytes)]`;
  const described = m.content ? `${marker}\n${m.content}` : marker;

  if (!isCurrent || fm.size > INLINE_ATTACHMENT_CAP) {
    return JSON.stringify({ text: described, ...base });
  }
  try {
    // Filenames on disk are the uuid+ext we generated at upload; basename of
    // the served URL is that name.
    const local = path.join(uploadsDir(roomId), path.basename(fm.url));
    const data = fs.readFileSync(local).toString('base64');
    // With a real attachment the formatter renders the "saved to
    // /workspace/inbox/..." line, so the caption alone is the right text —
    // same rule as the webchat upload path's inboundForFile.
    return JSON.stringify({
      text: m.content,
      ...base,
      attachments: [
        {
          name: fm.filename,
          type: fm.mime.startsWith('image/') ? 'image' : 'file',
          data,
          size: fm.size,
          mime: fm.mime,
        },
      ],
    });
  } catch (err) {
    // Unreadable on disk — still tell the agent the file exists rather than
    // handing it an empty message.
    log.warn('UserCreds fan-out: could not inline attachment', {
      file: fm.filename,
      err: err instanceof Error ? err.message : err,
    });
    return JSON.stringify({ text: described, ...base });
  }
}

export function writeMemberTranscript(args: SessionInboundWriterArgs): boolean {
  // Scope to the session's OWN thread. The session key is (user, thread); a
  // room-wide transcript is what mixed 89 main-thread rows with 60 topic-thread
  // rows in one member's queue, leaving the agent to answer a room message into
  // a topic thread. A legacy bare-user key has no thread — fall back to the
  // room-wide read so those sessions keep working unchanged.
  const thread = memberThreadFromKey(args.session.thread_id);
  const transcript = thread
    ? getWebchatMessages(args.roomId, TRANSCRIPT_LIMIT, thread)
    : getWebchatMessages(args.roomId, TRANSCRIPT_LIMIT);
  const msgs: ContextMessage[] = [];
  let sawCurrent = false;
  for (const m of transcript) {
    if (SKIP_TYPES.has((m as { message_type?: string }).message_type ?? '')) continue;
    const isCurrent = m.id === args.currentMessageId;
    if (isCurrent) sawCurrent = true;
    msgs.push({
      id: `user-creds-${args.session.id}-${m.id}`,
      kind: 'chat',
      timestamp: new Date(m.created_at).toISOString(),
      platformId: args.deliveryAddr.platformId,
      channelType: args.deliveryAddr.channelType,
      threadId: args.deliveryAddr.threadId,
      content: contentFor(m, args.roomId, isCurrent),
      trigger: isCurrent ? 1 : 0,
    });
  }
  // If the current message isn't in the transcript yet (timing), let the router
  // do its normal single-message write so the turn still wakes correctly.
  if (!sawCurrent) return false;
  syncSessionContext(args.agentGroupId, args.session.id, msgs);
  return true;
}
