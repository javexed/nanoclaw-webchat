/**
 * A message the server fails to store must not vanish silently: the sender
 * gets an error frame naming its client_id, and a resend of that client_id is
 * processed rather than dropped as a duplicate.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

const storeFail = vi.hoisted(() => ({ remaining: 0 }));

vi.mock('./request-guard.js', () => ({ originAllowed: () => true, hostAllowed: async () => true }));
vi.mock('./access.js', async (orig) => ({
  ...(await orig<typeof import('./access.js')>()),
  canAccessRoom: async () => true,
}));
vi.mock('./db.js', async (orig) => {
  const real = await orig<typeof import('./db.js')>();
  return {
    ...real,
    getWebchatRoom: async (id: string) => ({ id, name: id }),
    storeWebchatMessage: async (...args: Parameters<typeof real.storeWebchatMessage>) => {
      if (storeFail.remaining > 0) {
        storeFail.remaining--;
        throw new Error('database is locked');
      }
      return real.storeWebchatMessage(...args);
    },
  };
});

import { setupWebSocket } from './ws.js';

let server: http.Server;
let url: string;
const onInbound = vi.fn();

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  onInbound.mockReset();
  server = http.createServer();
  setupWebSocket(server, { onInbound }, async () => ({ userId: 'webchat:alice', displayName: 'Alice' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb();
});

function connect(): Promise<{ ws: WebSocket; next: (type: string) => Promise<Record<string, unknown>> }> {
  const ws = new WebSocket(url);
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
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next }));
    ws.once('error', reject);
  });
}

describe('WS message store failure', () => {
  it('sends an error frame for the client_id and lets a resend through', async () => {
    const { ws, next } = await connect();
    ws.send(JSON.stringify({ type: 'auth' }));
    await next('rooms');
    ws.send(JSON.stringify({ type: 'join', room_id: 'room-1' }));

    storeFail.remaining = 1;
    ws.send(JSON.stringify({ type: 'message', content: 'hello', client_id: 'local-1-1' }));
    const err = await next('error');
    expect(err.client_id).toBe('local-1-1');
    expect(onInbound).not.toHaveBeenCalled();

    ws.send(JSON.stringify({ type: 'message', content: 'hello', client_id: 'local-1-1' }));
    const echo = await next('message');
    expect(echo.client_id).toBe('local-1-1');
    expect(echo.content).toBe('hello');
    expect(onInbound).toHaveBeenCalledTimes(1);
    ws.close();
  });
});
