/**
 * The join's history frame carries where this user left off in the thread —
 * their read marker as it stood BEFORE the join advanced it — so the client
 * can open at the first unread message under a "New" divider.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

vi.mock('./request-guard.js', () => ({ originAllowed: () => true, hostAllowed: async () => true }));
vi.mock('./access.js', async (orig) => ({
  ...(await orig<typeof import('./access.js')>()),
  canAccessRoom: async () => true,
}));
vi.mock('./db.js', async (orig) => ({
  ...(await orig<typeof import('./db.js')>()),
  getWebchatRoom: async (id: string) => ({ id, name: id }),
}));

import { getThreadReadMarker, markThreadRead, storeWebchatMessage } from './db.js';
import { setupWebSocket } from './ws.js';

let server: http.Server;
let url: string;

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  server = http.createServer();
  setupWebSocket(server, { onInbound: vi.fn() }, async () => ({ userId: 'webchat:alice', displayName: 'Alice' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb();
});

function frame(ws: WebSocket, type: string): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const on = (raw: Buffer) => {
      const f = JSON.parse(raw.toString());
      if (f.type !== type) return;
      ws.off('message', on);
      resolve(f);
    };
    ws.on('message', on);
  });
}

async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.once('open', r));
  const rooms = frame(ws, 'rooms');
  ws.send(JSON.stringify({ type: 'auth' }));
  await rooms;
  return ws;
}

async function join(ws: WebSocket): Promise<Record<string, any>> {
  const history = frame(ws, 'history');
  ws.send(JSON.stringify({ type: 'join', room_id: 'room-1' }));
  return history;
}

describe('WS join history — last read marker', () => {
  it('is null on a first visit, then the marker the previous join left', async () => {
    await storeWebchatMessage('room-1', 'Bob', 'user', 'hi');
    const ws = await connect();
    expect((await join(ws)).last_read_at).toBeNull();
    const after = await getThreadReadMarker('webchat:alice', 'room-1', 'main');
    expect(after).toEqual(expect.any(Number));
    expect((await join(ws)).last_read_at).toBe(after);
    ws.close();
  });

  it('reports the marker from before this join, not the one it sets', async () => {
    await markThreadRead('webchat:alice', 'room-1', 'main', 1000);
    await storeWebchatMessage('room-1', 'Bob', 'user', 'while you were away');
    const ws = await connect();
    expect((await join(ws)).last_read_at).toBe(1000);
    expect(await getThreadReadMarker('webchat:alice', 'room-1', 'main')).toBeGreaterThan(1000);
    ws.close();
  });

  it("sending advances the sender's thread marker past their own message", async () => {
    const ws = await connect();
    await join(ws);
    await markThreadRead('webchat:alice', 'room-1', 'main', 0);
    await getDb().run(`DELETE FROM webchat_thread_reads`);
    ws.send(JSON.stringify({ type: 'message', content: 'mine', client_id: 'c1' }));
    let marker: number | null = null;
    for (let i = 0; i < 50 && marker === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      marker = await getThreadReadMarker('webchat:alice', 'room-1', 'main');
    }
    const row = (await getDb().get(`SELECT created_at FROM webchat_messages WHERE content = 'mine'`)) as {
      created_at: number;
    };
    expect(marker).toBeGreaterThanOrEqual(row.created_at);
    ws.close();
  });
});
