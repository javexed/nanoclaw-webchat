/**
 * The editor's chat view rides the runner socket. What must hold: only the
 * machine's own room, only for a user who may see it; a message from the
 * editor takes the PWA's exact path (store, mark read, broadcast, route);
 * replies reach every open view of that room and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetRunnerChatForTest, handleChatFrame, setupRunnerChat } from './runner-chat.js';
import { notifyRoomMessage, notifyRoomStatus } from './state.js';

const FP = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const me = { fingerprint: FP, userId: 'webchat:dev@x', displayName: 'Dev' };
const settle = () => new Promise((r) => setTimeout(r, 15));

let sent: Array<{ fp: string; frame: Record<string, unknown> }>;
let stored: Array<Record<string, unknown>>;
let routed: Array<{ roomId: string; text: string; threadId: string | null }>;
let read: Array<{ userId: string; roomId: string }>;
let access = true;
let turnOpen = false;

beforeEach(() => {
  sent = [];
  stored = [];
  routed = [];
  read = [];
  access = true;
  turnOpen = false;
  setupRunnerChat(
    (roomId, message, threadId) => routed.push({ roomId, text: (message.content as { text: string }).text, threadId }),
    {
      roomForMachine: async (fp) => (fp === FP ? { id: 'runner-w1', name: 'Runner · W1' } : null),
      canAccess: async () => access,
      history: async (roomId) => [
        {
          id: 'h1',
          room_id: roomId,
          thread_id: 'main',
          sender: 'Runner · W1',
          sender_type: 'agent',
          content: 'pong sk-ant-api03-SECRETSECRETSECRETSECRET', // leak-scan-allow — a fixture the redactor must catch
          message_type: 'text',
          created_at: 1,
        },
      ],
      store: async (roomId, sender, senderType, text) => {
        const m = {
          id: `m${stored.length + 1}`,
          room_id: roomId,
          thread_id: 'main',
          sender,
          sender_type: senderType,
          content: text,
          message_type: 'text' as const,
          created_at: 1000 + stored.length,
        };
        stored.push(m);
        return m;
      },
      markRead: (userId, roomId) => {
        read.push({ userId, roomId });
      },
      broadcast: async (roomId, msg) => notifyRoomMessage(roomId, msg), // what the real broadcast does for mirrors, minus the DB
      send: (fp, frame) => {
        sent.push({ fp, frame });
        return true;
      },
      redact: (s) => s.replace(/sk-ant-[A-Za-z0-9-]+/g, '[redacted]'),
      activeTurns: (roomId) => (roomId === 'runner-w1' && turnOpen ? ['Runner · W1'] : []),
    },
  );
});
afterEach(() => __resetRunnerChatForTest());

const frames = (fp: string, type: string) =>
  sent.filter((s) => s.fp === fp && s.frame.type === type).map((s) => s.frame);

describe('runner chat bridge', () => {
  it('opens only the machine’s own room, with redacted history', async () => {
    expect(handleChatFrame(me, { type: 'chat.open' })).toBe(true);
    await settle();
    const room = frames(FP, 'chat.room')[0];
    expect(room).toMatchObject({ roomId: 'runner-w1', name: 'Runner · W1' });
    expect((room.messages as Array<{ content: string }>)[0].content).toBe('pong [redacted]');

    // A machine with nothing placed, or a user without access, gets an error and no room.
    handleChatFrame({ ...me, fingerprint: OTHER }, { type: 'chat.open' });
    await settle();
    expect(frames(OTHER, 'chat.error')[0]).toMatchObject({ message: expect.stringContaining('no agent group') });
    access = false;
    sent.length = 0;
    handleChatFrame(me, { type: 'chat.open' });
    await settle();
    expect(frames(FP, 'chat.room')).toHaveLength(0);
    expect(frames(FP, 'chat.error')).toHaveLength(1);
  });

  it('a message from the editor is stored as the user, marked read, broadcast, routed to the agent, and echoed back', async () => {
    handleChatFrame(me, { type: 'chat.open' });
    await settle();
    sent.length = 0;
    handleChatFrame(me, { type: 'chat.send', text: '  fix the failing test  ' });
    await settle();
    expect(stored).toEqual([
      expect.objectContaining({ sender: 'Dev', sender_type: 'user', content: 'fix the failing test' }),
    ]);
    expect(read).toEqual([{ userId: 'webchat:dev@x', roomId: 'runner-w1' }]);
    expect(routed).toEqual([{ roomId: 'runner-w1', text: 'fix the failing test', threadId: null }]);
    // The broadcast came back to this view as chat.message (the same path an agent reply takes).
    expect(frames(FP, 'chat.message')[0]).toMatchObject({ id: 'm1', content: 'fix the failing test' });
  });

  it('refuses sends before open, empty and oversized text, and ignores non-chat frames', async () => {
    expect(handleChatFrame(me, { type: 'res', id: 'x' })).toBe(false);
    handleChatFrame(me, { type: 'chat.send', text: 'hi' });
    await settle();
    expect(frames(FP, 'chat.error')[0]).toMatchObject({ message: 'open the room first' });
    handleChatFrame(me, { type: 'chat.open' });
    await settle();
    sent.length = 0;
    handleChatFrame(me, { type: 'chat.send', text: '   ' });
    handleChatFrame(me, { type: 'chat.send', text: 'x'.repeat(40_000) });
    await settle();
    expect(frames(FP, 'chat.error').map((f) => f.message)).toEqual([
      'empty message',
      expect.stringContaining('too long'),
    ]);
    expect(stored).toHaveLength(0);
  });

  it('an agent reply broadcast to the room reaches the open view and no other machine', async () => {
    handleChatFrame(me, { type: 'chat.open' });
    await settle();
    sent.length = 0;
    notifyRoomMessage('runner-w1', {
      type: 'message',
      id: 'r1',
      room_id: 'runner-w1',
      sender: 'Runner · W1',
      sender_type: 'agent',
      content: 'done',
      created_at: 5,
    });
    notifyRoomMessage('other-room', {
      type: 'message',
      id: 'r2',
      room_id: 'other-room',
      sender: 'X',
      sender_type: 'agent',
      content: 'nope',
      created_at: 6,
    });
    expect(frames(FP, 'chat.message').map((f) => f.id)).toEqual(['r1']);
    expect(sent.filter((s) => s.fp !== FP)).toHaveLength(0);
  });

  it("the agent's activity reaches the open view, and a view opened mid-turn sees it working", async () => {
    turnOpen = true;
    handleChatFrame(me, { type: 'chat.open' });
    await settle();
    expect(frames(FP, 'chat.status')).toEqual([
      { type: 'chat.status', event: 'start', text: null, detail: null, agentName: 'Runner · W1' },
    ]);
    sent.length = 0;
    notifyRoomStatus('runner-w1', {
      type: 'status',
      room_id: 'runner-w1',
      agent_name: 'Runner · W1',
      event: 'tool',
      text: 'Read',
      detail: 'src/app.ts',
    });
    notifyRoomStatus('other-room', {
      type: 'status',
      room_id: 'other-room',
      event: 'tool',
      text: 'Bash',
      detail: 'ls',
    });
    expect(frames(FP, 'chat.status')).toEqual([
      { type: 'chat.status', event: 'tool', text: 'Read', detail: 'src/app.ts', agentName: 'Runner · W1' },
    ]);
    expect(sent.filter((s) => s.fp !== FP)).toHaveLength(0);
  });
});
