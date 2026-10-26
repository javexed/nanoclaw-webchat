import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { notifyProviderMessage } from './providers/hooks.js';
import { setCurrentReplyRoute } from './db/session-state.js';
import {
  PREVIEW_INTERVAL_MS,
  PREVIEW_MAX_CHARS,
  ReplyPreviewStream,
  extractReplyPreview,
  readStreamEvent,
} from './reply-preview.js';
import './status-feed.js';

const room = (name: string) => name === 'room';

describe('extractReplyPreview', () => {
  test('shows a complete block to the room', () => {
    expect(extractReplyPreview('<message to="room">Hello there</message>', room)).toBe('Hello there');
  });

  test('an open block shows up to its last complete word', () => {
    expect(extractReplyPreview('<message to="room">Hello the', room)).toBe('Hello');
    expect(extractReplyPreview('<message to="room">Hello there ', room)).toBe('Hello there');
  });

  test('a half-written closing or inline tag never shows', () => {
    expect(extractReplyPreview('<message to="room">Done. </mess', room)).toBe('Done.');
    expect(extractReplyPreview('<message to="room">See <a href="x', room)).toBe('See');
  });

  test('text outside a block is not previewed', () => {
    expect(extractReplyPreview('Let me check the logs first.', room)).toBe('');
    expect(extractReplyPreview('<message to="ro', room)).toBe('');
  });

  test('blocks to other destinations are not previewed', () => {
    const text = '<message to="other-agent">secret plan</message><message to="room">Hi</message>';
    expect(extractReplyPreview(text, room)).toBe('Hi');
  });

  test('internal spans are withheld, closed or not', () => {
    expect(
      extractReplyPreview('<internal><message to="room">draft</message></internal><message to="room">real ', room),
    ).toBe('real');
    expect(extractReplyPreview('<message to="room">a</message><internal>thinking <message to="room">no', room)).toBe(
      'a',
    );
  });

  test('several room blocks join in order', () => {
    expect(extractReplyPreview('<message to="room">one</message> <message to="room">two </message>', room)).toBe(
      'one\n\ntwo',
    );
  });

  test('a long reply is capped to its most recent text', () => {
    const body = 'word '.repeat(2000);
    const out = extractReplyPreview(`<message to="room">${body}`, room);
    expect(out.length).toBe(PREVIEW_MAX_CHARS);
    expect(out.startsWith('…')).toBe(true);
  });
});

describe('readStreamEvent', () => {
  test('text deltas and message starts; everything else is nothing', () => {
    expect(readStreamEvent({ event: { type: 'message_start' } })).toEqual({ reset: true });
    expect(
      readStreamEvent({ event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }),
    ).toEqual({ text: 'hi' });
    expect(
      readStreamEvent({ event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } } }),
    ).toBeNull();
    expect(readStreamEvent({ event: { type: 'message_stop' } })).toBeNull();
    expect(readStreamEvent(undefined)).toBeNull();
  });

  test("a subagent's stream is not the reply", () => {
    expect(
      readStreamEvent({
        parent_tool_use_id: 'tool-1',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      }),
    ).toBeNull();
  });
});

describe('ReplyPreviewStream', () => {
  function harness() {
    let now = 0;
    const writes: Array<[string | null, string | null]> = [];
    const stream = new ReplyPreviewStream({
      resolveRoom: (name) => (name === 'room' ? 'chat-1' : null),
      write: (text, r) => writes.push([text, r]),
      now: () => now,
    });
    return { stream, writes, tick: (ms: number) => (now += ms) };
  }

  test('throttles writes and skips unchanged previews', () => {
    const { stream, writes, tick } = harness();
    stream.delta('<message to="room">Hello ');
    stream.delta('world ');
    expect(writes).toEqual([['Hello', 'chat-1']]);
    tick(PREVIEW_INTERVAL_MS);
    stream.delta('again ');
    expect(writes.at(-1)).toEqual(['Hello world again', 'chat-1']);
    tick(PREVIEW_INTERVAL_MS);
    stream.delta('x'); // a partial word: the preview is unchanged
    expect(writes).toHaveLength(2);
  });

  test('end clears a shown preview, and only a shown one', () => {
    const { stream, writes } = harness();
    stream.end();
    expect(writes).toEqual([]);
    stream.delta('<message to="room">Hi ');
    stream.end();
    expect(writes).toEqual([
      ['Hi', 'chat-1'],
      [null, 'chat-1'],
    ]);
  });

  test('never writes for a block it may not preview', () => {
    const { stream, writes } = harness();
    stream.delta('<message to="elsewhere">Hidden text ');
    stream.end();
    expect(writes).toEqual([]);
  });
});

describe('status feed wiring', () => {
  beforeEach(() => {
    initTestSessionDb();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('room', 'Room', 'channel', 'webchat', 'chat-1', NULL),
                ('slack', 'Slack', 'channel', 'slack', 'C1', NULL)`,
      )
      .run();
  });
  afterEach(() => {
    notifyProviderMessage({ kind: 'turn_done' });
    closeSessionDb();
  });

  let seq = 0;
  function seedInbound(id: string, kind: string): void {
    seq += 2;
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, "trigger", platform_id, channel_type, content)
         VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 'processing', 1, 'chat-1', 'webchat', '{}')`,
      )
      .run(id, seq, kind);
  }

  const stream = (text: string) =>
    notifyProviderMessage({
      kind: 'sdk_stream',
      event: { event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
    } as unknown as Parameters<typeof notifyProviderMessage>[0]);

  function rows(): Array<{ kind: string; text: string | null; detail: string | null }> {
    return getOutboundDb().prepare('SELECT kind, text, detail FROM status_events ORDER BY seq').all() as Array<{
      kind: string;
      text: string | null;
      detail: string | null;
    }>;
  }

  test('a reply to the webchat room previews, then clears before delivery and before done', () => {
    seedInbound('m1', 'chat');
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'webchat', platformId: 'chat-1', threadId: null });
    notifyProviderMessage({ kind: 'turn_start' });
    stream('<message to="room">Working on it ');
    expect(rows().filter((r) => r.kind === 'preview')).toEqual([
      { kind: 'preview', text: 'Working on it', detail: 'chat-1' },
    ]);
    notifyProviderMessage({ kind: 'assistant_message' } as unknown as Parameters<typeof notifyProviderMessage>[0]);
    // One preview row at most: the clear replaced the text.
    expect(rows().filter((r) => r.kind === 'preview')).toEqual([{ kind: 'preview', text: null, detail: 'chat-1' }]);
    notifyProviderMessage({ kind: 'turn_done' });
    expect(rows().at(-1)?.kind).toBe('done');
  });

  test('an interrupted reply is cleared at the turn boundary', () => {
    seedInbound('m1', 'chat');
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'webchat', platformId: 'chat-1', threadId: null });
    stream('<message to="room">Half a ');
    notifyProviderMessage({ kind: 'turn_done' });
    const r = rows();
    expect(r.at(-2)).toEqual({ kind: 'preview', text: null, detail: 'chat-1' });
    expect(r.at(-1)?.kind).toBe('done');
  });

  test('no preview for another channel, another room, or a task run', () => {
    seedInbound('m1', 'chat');
    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'webchat', platformId: 'chat-1', threadId: null });
    stream('<message to="slack">to slack ');
    notifyProviderMessage({ kind: 'turn_done' });

    setCurrentReplyRoute({ inReplyTo: 'm1', channelType: 'webchat', platformId: 'chat-2', threadId: null });
    stream('<message to="room">not this turn\'s room ');
    notifyProviderMessage({ kind: 'turn_done' });

    seedInbound('t1', 'task');
    setCurrentReplyRoute({ inReplyTo: 't1', channelType: 'webchat', platformId: 'chat-1', threadId: null });
    stream('<message to="room">task text ');
    notifyProviderMessage({ kind: 'turn_done' });

    expect(rows().filter((r) => r.kind === 'preview')).toEqual([]);
  });
});
