/**
 * The status frame for a reply an agent is still writing (event 'preview').
 * It is the reply's own text, so it names its thread and a client shows it
 * only in that thread; redacted like every other frame.
 */
import type { ReplyPreview } from '../../modules/agent-status/observers.js';

import { sessionKeyToThread } from './db.js';
import { redactSensitiveData } from './redact.js';

export async function replyPreviewFrame(preview: ReplyPreview): Promise<Record<string, unknown>> {
  return {
    type: 'status',
    room_id: preview.platformId,
    thread_id: await sessionKeyToThread(preview.threadId, preview.platformId),
    agent_name: preview.agentName,
    event: 'preview',
    text: preview.text === null ? null : redactSensitiveData(preview.text),
    detail: null,
  };
}
