// ── Live reply preview ──────────────────────────────────────────────────────
// Whether a 'preview' status frame (the reply an agent is still writing) is
// shown. It is the reply's own text, so it shows only in the thread it is
// being written in, and only into a bubble that is already up: one arriving
// after the turn ended ('done'/'stalled') must not reopen it. A clear (no
// text) always applies — it never opens a bubble, and it can trail a thread
// switch.

export function replyPreviewApplies(
  frame: { thread_id?: unknown; text?: unknown },
  currentThread: string,
  turnOpen: boolean,
): boolean {
  if (!frame.text) return true;
  if (!turnOpen) return false;
  return typeof frame.thread_id !== 'string' || frame.thread_id === currentThread;
}
