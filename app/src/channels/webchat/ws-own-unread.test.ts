/**
 * A message is never unread for the user who wrote it: their own devices in
 * other rooms get no `unread` signal and no push for it, while everyone else
 * still does. The sender's user id decides this server-side and never rides
 * the frame.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

const push = vi.hoisted(() => ({ calls: [] as Array<{ senderUserId?: string }> }));

vi.mock('./request-guard.js', () => ({ originAllowed: () => true, hostAllowed: async () => true }));
vi.mock('./access.js', async (orig) => ({
  ...(await orig<typeof import('./access.js')>()),
  canAccessRoom: async () => true,
}));
vi.mock('./db.js', async (orig) => ({
  ...(await orig<typeof import('./db.js')>()),
  getWebchatRoom: async (id: string) => ({ id, name: id }),
}));
vi.mock('./push.js', async (orig) => ({
  ...(await orig<typeof import('./push.js')>()),
  sendPushForMessage: async (p: { senderUserId?: string }) => {
    push.calls.push(p);
  },
}));

import { broadcast, clients } from './state.js';
import { setupWebSocket } from './ws.js';

let server: http.Server;
let url: string;

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  push.calls = [];
  server = http.createServer();
  setupWebSocket(server, { onInbound: vi.fn() }, async (req) => {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
    return { userId: q.get('u')!, displayName: q.get('n')! };
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  for (const c of [...clients.values()]) c.ws.terminate();
  clients.clear();
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb();
});

interface Conn {
  ws: WebSocket;
  frames: Array<Record<string, any>>;
}

/** Connect as `user`, authenticate, and sit in `room`. Every frame is recorded. */
async function connectIn(user: string, name: string, room: string): Promise<Conn> {
  const ws = new WebSocket(`${url}?u=${encodeURIComponent(user)}&n=${encodeURIComponent(name)}`);
  const frames: Array<Record<string, any>> = [];
  ws.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'auth' }));
  await until(() => frames.some((f) => f.type === 'rooms'));
  ws.send(JSON.stringify({ type: 'join', room_id: room }));
  await until(() => frames.some((f) => f.type === 'history'));
  return { ws, frames };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('timed out');
}

const unreadFor = (c: Conn, room: string) => c.frames.filter((f) => f.type === 'unread' && f.room_id === room);

describe('own messages never come back as unread', () => {
  it("a typed message signals unread to others, not to the sender's other devices", async () => {
    const phone = await connectIn('webchat:alice', 'Alice', 'room-1');
    const laptop = await connectIn('webchat:alice', 'Alice', 'room-2');
    const bob = await connectIn('webchat:bob', 'Bob', 'room-2');

    phone.ws.send(JSON.stringify({ type: 'message', content: 'from my phone', client_id: 'c1' }));
    await until(() => unreadFor(bob, 'room-1').length > 0);
    // Bob's frame arriving means the fan-out finished; the laptop's would have come in the same loop.
    await new Promise((r) => setTimeout(r, 50));

    expect(unreadFor(laptop, 'room-1')).toEqual([]);
    expect(unreadFor(bob, 'room-1')).toHaveLength(1);
    // No user id leaks onto any frame.
    expect(JSON.stringify([...laptop.frames, ...bob.frames])).not.toContain('webchat:alice');
    expect(push.calls.at(-1)?.senderUserId).toBe('webchat:alice');
  });

  it('a broadcast naming its sender (an upload) skips that user elsewhere and in push', async () => {
    const laptop = await connectIn('webchat:alice', 'Alice', 'room-2');
    const bob = await connectIn('webchat:bob', 'Bob', 'room-2');

    await broadcast(
      'room-1',
      { type: 'message', id: 'f1', room_id: 'room-1', sender: 'Alice', content: 'a file' },
      undefined,
      'webchat:alice',
    );
    await until(() => unreadFor(bob, 'room-1').length > 0);

    expect(unreadFor(laptop, 'room-1')).toEqual([]);
    expect(push.calls.at(-1)?.senderUserId).toBe('webchat:alice');
  });

  it('a message with no user sender (an agent reply) still reaches all of them', async () => {
    const laptop = await connectIn('webchat:alice', 'Alice', 'room-2');
    await broadcast('room-1', { type: 'message', id: 'a1', room_id: 'room-1', sender: 'Agent', content: 'hi' });
    await until(() => unreadFor(laptop, 'room-1').length > 0);
    expect(unreadFor(laptop, 'room-1')).toHaveLength(1);
  });
});
