/**
 * The join's history frame — the transcript the client paints first — flags a
 * reply that has a stored turn trace, and carries no trace itself.
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

import { storeWebchatMessage } from './db.js';
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

describe('WS join history', () => {
  it('flags the reply that anchors a stored trace', async () => {
    const traced = await storeWebchatMessage('room-1', 'AG', 'agent', 'with thoughts');
    const plain = await storeWebchatMessage('room-1', 'AG', 'agent', 'without');
    await getDb().run(
      `INSERT INTO webchat_turn_traces (id, room_id, thread_id, message_id, message_ids, started_at, outcome, trace_json, size)
       VALUES ('t1', 'room-1', 'main', ?, ?, ?, 'done', '{"tools":[{"name":"SECRET_TOOL"}]}', 10)`,
      traced.id,
      JSON.stringify([traced.id]),
      Date.now(),
    );
    const ws = new WebSocket(url);
    await new Promise((r) => ws.once('open', r));
    const rooms = frame(ws, 'rooms');
    ws.send(JSON.stringify({ type: 'auth' }));
    await rooms;
    const history = frame(ws, 'history');
    ws.send(JSON.stringify({ type: 'join', room_id: 'room-1' }));
    const h = await history;
    const byId = new Map((h.messages as Record<string, unknown>[]).map((m) => [m.id, m]));
    expect(byId.get(traced.id)).toMatchObject({ has_trace: true });
    expect(byId.get(plain.id)).not.toHaveProperty('has_trace');
    expect(JSON.stringify(h)).not.toContain('SECRET_TOOL');
    ws.close();
  });
});
