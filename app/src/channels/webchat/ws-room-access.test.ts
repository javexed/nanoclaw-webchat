/**
 * Room access over an open socket, and who may delete a message.
 *
 *   - Access is re-checked on every room-scoped frame, not only at `join`: a
 *     client that lost access to its room can no longer send, type, interrupt
 *     or delete there, and is unbound from the room.
 *   - A message is deleted by its sender's user id, never by display name:
 *     two users sharing a name cannot delete each other's messages. A row
 *     stored before sender ids existed is deletable only by an owner or admin
 *     of the room whose name matches its sender.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

const access = vi.hoisted(() => ({ allowed: true, admin: false, checks: 0 }));
const interrupts = vi.hoisted(() => ({ lookups: 0 }));

vi.mock('./request-guard.js', () => ({ originAllowed: () => true, hostAllowed: async () => true }));
vi.mock('./access.js', async (orig) => ({
  ...(await orig<typeof import('./access.js')>()),
  canAccessRoom: async () => {
    access.checks++;
    return access.allowed;
  },
  filterRoomsForUser: async <T>(_userId: string, rooms: T[]) => (access.allowed ? rooms : []),
  canArchiveRoom: async () => access.admin,
}));
vi.mock('../../db/messaging-groups.js', async (orig) => {
  const real = await orig<typeof import('../../db/messaging-groups.js')>();
  return {
    ...real,
    getMessagingGroupByPlatform: async (...args: Parameters<typeof real.getMessagingGroupByPlatform>) => {
      interrupts.lookups++;
      return real.getMessagingGroupByPlatform(...args);
    },
  };
});

import { createWebchatRoom, deleteWebchatMessage, getWebchatMessages, storeWebchatMessage } from './db.js';
import { broadcastRooms, clients } from './state.js';
import { setupWebSocket } from './ws.js';

let server: http.Server;
let url: string;
const onInbound = vi.fn();

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  await createWebchatRoom('Room', 'room-1');
  access.allowed = true;
  access.admin = false;
  access.checks = 0;
  interrupts.lookups = 0;
  onInbound.mockReset();
  server = http.createServer();
  // The identity comes from the query string: `u` the user id, `n` the display name.
  setupWebSocket(server, { onInbound }, async (req) => {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
    return { userId: q.get('u') ?? 'webchat:alice', displayName: q.get('n') ?? 'Alice' };
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
  frames: Record<string, unknown>[];
  next: (type: string) => Promise<Record<string, unknown>>;
  send: (frame: object) => void;
}

async function connect(userId: string, name: string): Promise<Conn> {
  const ws = new WebSocket(`${url}?u=${encodeURIComponent(userId)}&n=${encodeURIComponent(name)}`);
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (raw) => {
    frames.push(JSON.parse(raw.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (type: string): Promise<Record<string, unknown>> => {
    for (;;) {
      const i = frames.findIndex((f) => f.type === type);
      if (i >= 0) return frames.splice(i, 1)[0];
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const conn: Conn = { ws, frames, next, send: (f) => ws.send(JSON.stringify(f)) };
  conn.send({ type: 'auth' });
  await next('rooms');
  conn.send({ type: 'join', room_id: 'room-1' });
  await next('history');
  return conn;
}

/** Wait until every frame sent so far has been handled: frames run in order, and `auth` always answers. */
async function settle(c: Conn): Promise<void> {
  c.send({ type: 'auth' });
  await c.next('rooms');
}

describe('room access is re-checked on every room-scoped frame', () => {
  it('a client that lost access can no longer send, type, interrupt or delete', async () => {
    const alice = await connect('webchat:alice', 'Alice');
    const bob = await connect('webchat:bob', 'Bob');
    alice.send({ type: 'message', content: 'before' });
    await alice.next('message');
    const [mine] = await getWebchatMessages('room-1');
    bob.frames.length = 0;

    access.allowed = false;
    alice.send({ type: 'typing', is_typing: true });
    const denied = await alice.next('error');
    expect(denied).toMatchObject({ error: 'Access denied', room_id: 'room-1' });

    // Unbound: every later room-scoped frame is refused without acting.
    alice.send({ type: 'message', content: 'after', client_id: 'c-after' });
    expect((await alice.next('error')).error).toBe('Join a room first');
    interrupts.lookups = 0;
    alice.send({ type: 'interrupt' });
    alice.send({ type: 'delete_message', message_id: mine.id });
    await settle(alice);

    expect((await getWebchatMessages('room-1')).map((m) => m.content)).toEqual(['before']);
    expect(onInbound).toHaveBeenCalledTimes(1); // only 'before'
    expect(interrupts.lookups).toBe(0);
    expect(bob.frames.some((f) => f.type === 'typing' || f.type === 'delete_message')).toBe(false);
  });

  it('each frame is checked, not only the first after join', async () => {
    const alice = await connect('webchat:alice', 'Alice');
    const before = access.checks;
    alice.send({ type: 'typing', is_typing: true });
    alice.send({ type: 'message', content: 'one' });
    await alice.next('message');
    alice.send({ type: 'interrupt' });
    await settle(alice);
    expect(access.checks - before).toBe(3);

    access.allowed = false;
    alice.send({ type: 'message', content: 'two' });
    expect((await alice.next('error')).error).toBe('Access denied');
    expect((await getWebchatMessages('room-1')).map((m) => m.content)).toEqual(['one']);
  });

  it('broadcastRooms unbinds a socket whose room left the user’s list', async () => {
    const alice = await connect('webchat:alice', 'Alice');
    const client = [...clients.values()].find((c) => c.userId === 'webchat:alice')!;
    await broadcastRooms();
    expect(client.room_id).toBe('room-1');

    access.allowed = false;
    await broadcastRooms();
    expect(client.room_id).toBeUndefined();
    expect((await alice.next('error')).error).toBe('Access denied');
  });
});

describe('deleting a message matches the sender’s user id, not their name', () => {
  it('a user sharing a display name cannot delete another’s message; the sender can', async () => {
    const alice = await connect('webchat:alice', 'Alex');
    const other = await connect('webchat:alex', 'Alex');
    alice.send({ type: 'message', content: 'mine' });
    const stored = await alice.next('message');
    expect(stored).not.toHaveProperty('sender_user_id');

    other.send({ type: 'delete_message', message_id: stored.id });
    await settle(other);
    expect(await getWebchatMessages('room-1')).toHaveLength(1);

    alice.send({ type: 'delete_message', message_id: stored.id });
    expect((await alice.next('delete_message')).message_id).toBe(stored.id);
    expect(await getWebchatMessages('room-1')).toHaveLength(0);
  });

  it('a room admin cannot delete another user’s message by sharing their name', async () => {
    const bob = await connect('webchat:bob', 'Sam');
    const admin = await connect('webchat:owner', 'Sam');
    bob.send({ type: 'message', content: 'bob says' });
    const stored = await bob.next('message');
    access.admin = true;
    admin.send({ type: 'delete_message', message_id: stored.id });
    await settle(admin);
    expect(await getWebchatMessages('room-1')).toHaveLength(1);
  });

  it('a row without a sender id: refused for members, allowed for a room admin whose name matches', async () => {
    const legacy = await storeWebchatMessage('room-1', 'Alice', 'user', 'old');
    const agentLegacy = await storeWebchatMessage('room-1', 'Alice', 'agent', 'agent reply');

    expect(await deleteWebchatMessage(legacy.id, 'webchat:alice', 'room-1')).toBe(false);
    expect(await deleteWebchatMessage(legacy.id, 'webchat:owner', 'room-1', 'Bob')).toBe(false);
    expect(await deleteWebchatMessage(agentLegacy.id, 'webchat:owner', 'room-1', 'Alice')).toBe(false);
    expect(await deleteWebchatMessage(legacy.id, 'webchat:owner', 'other-room', 'Alice')).toBe(false);
    expect(await deleteWebchatMessage(legacy.id, 'webchat:owner', 'room-1', 'Alice')).toBe(true);

    // Over the socket: a member is refused, an admin with the matching name is not.
    const again = await storeWebchatMessage('room-1', 'Alice', 'user', 'old again');
    const alice = await connect('webchat:alice', 'Alice');
    alice.send({ type: 'delete_message', message_id: again.id });
    await settle(alice);
    expect((await getWebchatMessages('room-1')).map((m) => m.id)).toContain(again.id);
    access.admin = true;
    alice.send({ type: 'delete_message', message_id: again.id });
    expect((await alice.next('delete_message')).message_id).toBe(again.id);
  });

  it('a stored message keeps its sender id server-side only', async () => {
    const stored = await storeWebchatMessage('room-1', 'Alice', 'user', 'hi', 'main', 'webchat:alice');
    expect(stored).not.toHaveProperty('sender_user_id');
    const row = (await getDb().get(`SELECT sender_user_id FROM webchat_messages WHERE id = ?`, stored.id)) as {
      sender_user_id: string;
    };
    expect(row.sender_user_id).toBe('webchat:alice');
    expect((await getWebchatMessages('room-1'))[0]).not.toHaveProperty('sender_user_id');
  });
});
