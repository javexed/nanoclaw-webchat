/**
 * Live reply preview: the text of a reply while the model is still writing it.
 *
 * A reply is only delivered once its `<message to="…">` block closes, which for
 * a long answer can take a while. Providers that stream text deltas (Claude
 * does) let the webchat show the block's body as it grows, inside the agent's
 * thinking bubble; the delivered message replaces it.
 *
 * The preview is ephemeral by construction: it rides the status feed as ONE
 * replaceable row (see writeReplyPreview in status-feed.ts), never becomes a
 * message, and only ever shows text that is on its way to the room the turn
 * came from. Text outside a block, inside an `<internal>` span, or addressed
 * to anyone else (another agent, another channel) is never previewed — the
 * same visibility rules the mid-turn delivery scan applies, so a preview never
 * shows text that could not be delivered there.
 *
 * Providers without text deltas never call in here: no preview, today's
 * behavior.
 */

/** Longest preview sent; longer replies show their most recent text. */
export const PREVIEW_MAX_CHARS = 6000;
/** Minimum spacing between preview writes (at most four a second). */
export const PREVIEW_INTERVAL_MS = 250;

const INTERNAL_SPAN_RE = /<internal\b[\s\S]*?<\/internal>/gi;
const OPEN_INTERNAL_RE = /<internal\b/i;
const MESSAGE_OPEN_RE = /<message\s+to="([^"]+)"\s*>/g;
const MESSAGE_CLOSE = '</message>';
/** A tag cut off mid-stream at the end of the text: `<`, `</mess`, `<b class="x`. */
const TRAILING_PARTIAL_TAG_RE = /<\/?(?:[A-Za-z][^<>]*)?$/;

/**
 * The previewable text in one assistant message's text so far: the bodies of
 * `<message to="NAME">` blocks whose NAME `accepts`, in order. An unclosed
 * block shows up to its last complete word, so a cut-off tag or a half-written
 * token never reaches the room. Everything from an unclosed `<internal` on is
 * withheld until it closes (and then dropped, like any internal span).
 */
export function extractReplyPreview(text: string, accepts: (toName: string) => boolean): string {
  let visible = text.replace(INTERNAL_SPAN_RE, '');
  const openInternal = visible.search(OPEN_INTERNAL_RE);
  if (openInternal !== -1) visible = visible.slice(0, openInternal);

  const bodies: string[] = [];
  MESSAGE_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MESSAGE_OPEN_RE.exec(visible)) !== null) {
    const start = m.index + m[0].length;
    const close = visible.indexOf(MESSAGE_CLOSE, start);
    let body: string;
    if (close === -1) {
      // Still being written: hold back the trailing partial word and any
      // half-open tag before it.
      body = visible.slice(start).replace(/\S*$/, '').replace(TRAILING_PARTIAL_TAG_RE, '');
    } else {
      body = visible.slice(start, close);
      MESSAGE_OPEN_RE.lastIndex = close + MESSAGE_CLOSE.length;
    }
    body = body.trim();
    if (body && accepts(m[1])) bodies.push(body);
    if (close === -1) break;
  }
  const joined = bodies.join('\n\n');
  return joined.length > PREVIEW_MAX_CHARS ? `…${joined.slice(-(PREVIEW_MAX_CHARS - 1))}` : joined;
}

/**
 * What one SDK `stream_event` means for the preview: a new assistant message
 * (start over), a text delta, or nothing. Subagent streams (a non-null
 * parent_tool_use_id) are not the reply and are ignored.
 */
export function readStreamEvent(message: unknown): { reset: true } | { text: string } | null {
  const m = message as {
    parent_tool_use_id?: string | null;
    event?: { type?: string; delta?: { type?: string; text?: string } };
  };
  if (m?.parent_tool_use_id) return null;
  const ev = m?.event;
  if (ev?.type === 'message_start') return { reset: true };
  if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
    return { text: ev.delta.text };
  }
  return null;
}

export interface ReplyPreviewDeps {
  /** The room a block addressed to `toName` would preview into, or null when it must not preview. */
  resolveRoom(toName: string): string | null;
  /** Write the preview for `room`; `text` null clears it. */
  write(text: string | null, room: string | null): void;
  now(): number;
}

/**
 * Accumulates one assistant message's streamed text and writes a throttled
 * preview. `end()` clears a shown preview: it runs when the complete message
 * arrives (before the runner delivers it, so the clear is always ahead of the
 * real message on the feed) and at every turn boundary.
 */
export class ReplyPreviewStream {
  private buffer = '';
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  private shown = '';
  private shownRoom: string | null = null;
  private rooms = new Map<string, string | null>();

  constructor(private readonly deps: ReplyPreviewDeps) {}

  /** Append a text delta; at most every PREVIEW_INTERVAL_MS, rescan and write a changed preview. */
  delta(text: string): void {
    this.buffer += text;
    const now = this.deps.now();
    // The throttle covers the scan as well as the write: a long reply with
    // nothing to preview must not be rescanned on every token.
    if (now - this.lastCheckAt < PREVIEW_INTERVAL_MS) return;
    this.lastCheckAt = now;
    let room: string | null = null;
    const preview = extractReplyPreview(this.buffer, (name) => {
      const r = this.roomFor(name);
      // Every previewed block goes to one room: the turn's origin.
      if (r !== null && (room === null || room === r)) {
        room = r;
        return true;
      }
      return false;
    });
    if (!preview || (preview === this.shown && room === this.shownRoom)) return;
    this.shown = preview;
    this.shownRoom = room;
    this.deps.write(preview, room);
  }

  /** The message is complete, or the turn moved on: clear any shown preview and start over. */
  end(): void {
    if (this.shown) this.deps.write(null, this.shownRoom);
    this.buffer = '';
    this.shown = '';
    this.shownRoom = null;
    this.lastCheckAt = Number.NEGATIVE_INFINITY;
    this.rooms.clear();
  }

  private roomFor(name: string): string | null {
    if (!this.rooms.has(name)) {
      let room: string | null = null;
      try {
        room = this.deps.resolveRoom(name);
      } catch {
        room = null;
      }
      this.rooms.set(name, room);
    }
    return this.rooms.get(name) ?? null;
  }
}
