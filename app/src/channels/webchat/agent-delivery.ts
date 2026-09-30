/**
 * Storing one agent delivery (text + attachments) into a room, retry-safe.
 *
 * Trunk retries a failed deliver() with the same outbound row, and the text is
 * stored before the attachments, so a failed attachment must not re-store the
 * text. The adapter isn't given the row id, so progress is keyed on what a
 * retry repeats exactly: session, room, thread and raw content. An entry lives
 * only while a delivery is part-done, and a stale one ages out.
 */
import type { OutboundFile } from '../adapter.js';

import { storeWebchatFileMessage, storeWebchatMessage, type FileMeta } from './db.js';

export interface DeliverySink {
  broadcast: (roomId: string, payload: unknown) => void;
  persistOutboundFile: (roomId: string, file: OutboundFile) => string;
}

interface Progress {
  textId: string | null;
  filesDone: number;
  at: number;
}

// Retries run on the next delivery polls, seconds apart. Anything older is a
// delivery trunk has given up on.
const PENDING_TTL_MS = 10 * 60_000;
const PENDING_BOUND = 500;
const pending = new Map<string, Progress>();

function prune(now: number): void {
  for (const [k, p] of pending) {
    if (now - p.at > PENDING_TTL_MS || pending.size > PENDING_BOUND) pending.delete(k);
  }
}

export function deliveryKey(sessionId: string | undefined, roomId: string, thread: string, content: unknown): string {
  return JSON.stringify([sessionId ?? null, roomId, thread, content]);
}

/**
 * Store and broadcast the text, then each attachment, skipping whatever an
 * earlier attempt of the same delivery already stored. Returns the text
 * message's id (from this attempt or the earlier one), or null when there
 * is no text.
 */
export async function storeAgentDelivery(
  sink: DeliverySink,
  d: {
    key: string;
    roomId: string;
    senderName: string;
    text: string | null;
    files: OutboundFile[] | undefined;
    thread: string;
  },
): Promise<string | null> {
  const now = Date.now();
  prune(now);
  const progress = pending.get(d.key) ?? { textId: null, filesDone: 0, at: now };
  pending.set(d.key, progress);
  if (d.text !== null && d.text.length > 0 && progress.textId === null) {
    const stored = await storeWebchatMessage(d.roomId, d.senderName, 'agent', d.text, d.thread);
    progress.textId = stored.id;
    sink.broadcast(d.roomId, { type: 'message', ...stored });
  }
  // File attachments: stored as separate file messages so the PWA renders
  // them inline. Each file gets its own message_type='file' row.
  const files = d.files ?? [];
  for (let i = progress.filesDone; i < files.length; i++) {
    const file = files[i];
    const meta: FileMeta = {
      url: sink.persistOutboundFile(d.roomId, file),
      filename: file.filename,
      mime: guessMime(file.filename),
      size: file.data.length,
    };
    const stored = await storeWebchatFileMessage(d.roomId, d.senderName, 'agent', file.filename, meta, d.thread);
    progress.filesDone = i + 1;
    sink.broadcast(d.roomId, { type: 'message', ...stored });
  }
  pending.delete(d.key);
  return progress.textId;
}

export function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
  };
  return map[ext] ?? 'application/octet-stream';
}
