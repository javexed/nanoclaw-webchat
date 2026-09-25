/**
 * Runner endpoint — admission, hello/welcome, keepalive, coexistence with /ws.
 * A real http.Server on an ephemeral port and a real `ws` client; auth is a
 * header-driven fake so the OIDC bar can be exercised without tokens.
 */
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { AuthFailure, AuthResult } from './auth.js';
import {
  MAX_PAYLOAD,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_WS_PATH,
  __resetRunnersForTest,
  applyPairingChange,
  listRunners,
  setupRunnerWebSocket,
} from './runner-ws.js';
import type { RunnerMachineRow, RunnerRegistryPort } from './runner-registry.js';
import { isRunnerConnected } from './runner-transport.js';
// In-memory stand-in for the machine registry: no DB in these tests. Approved
// by default; individual tests override.
const fakeMachines = new Map<string, RunnerMachineRow>();
const fakeRegistry: RunnerRegistryPort = {
  async recordMachineSeen(seen) {
    const prev = fakeMachines.get(seen.fingerprint);
    if (prev && prev.user_id !== seen.userId) return prev;
    const row: RunnerMachineRow = {
      fingerprint: seen.fingerprint,
      user_id: seen.userId,
      hostname: seen.hostname,
      os: seen.os,
      arch: seen.arch,
      runner_version: seen.runnerVersion,
      status: prev?.status ?? 'approved',
      approval_id: null,
      approved_by: null,
      approved_at: null,
      revoked_by: null,
      revoked_at: null,
      first_seen: prev?.first_seen ?? 1,
      last_seen: 2,
    };
    fakeMachines.set(seen.fingerprint, row);
    return row;
  },
  async getMachine(fp) {
    return fakeMachines.get(fp);
  },
};
const pendingSeen: string[] = [];

import { __resetUpgradeHandlersForTest, setupWebSocket } from './ws.js';

const fakeAuth = async (req: http.IncomingMessage): Promise<AuthResult | AuthFailure> => {
  const who = req.headers['x-test-auth'];
  if (who === 'oidc')
    return { ok: true, userId: 'webchat:jane.doe@example.com', displayName: 'Jane Doe', source: 'oidc' };
  if (who === 'tailscale')
    return {
      ok: true,
      userId: 'webchat:tailscale:jane@example.com',
      displayName: 'jane@example.com',
      source: 'tailscale',
    };
  if (who === 'proxy')
    return { ok: true, userId: 'webchat:jane.doe@example.com', displayName: 'Jane Doe', source: 'proxy-header' };
  if (who === 'bearer') return { ok: true, userId: 'webchat:owner', displayName: 'operator', source: 'bearer' };
  return { ok: false, reason: 'Unauthorized' };
};

/** Small, so the oversized-frame test does not stall the loop the keepalive tests time. */
const TEST_MAX_PAYLOAD = 64 * 1024;
let server: http.Server;
let base: string;
const sockets: WebSocket[] = [];

/** Reply to the server's JSON keepalive the way a real runner does, so a socket held open across awaits stays alive. */
function answerPings(ws: WebSocket): void {
  ws.on('message', (data) => {
    try {
      const f = JSON.parse(String(data)) as { type?: string; t?: number };
      if (f.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: f.t }));
    } catch {
      /* not JSON — not a keepalive */
    }
  });
}

function open(path: string, auth?: string): WebSocket {
  const ws = new WebSocket(`${base}${path}`, { headers: auth ? { 'x-test-auth': auth } : {} });
  sockets.push(ws);
  return ws;
}
const nextFrame = (ws: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
const opened = (ws: WebSocket): Promise<void> =>
  new Promise((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
const rejectedWith = (ws: WebSocket): Promise<number> =>
  new Promise((resolve) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('error', () => resolve(0));
  });
const hello = (fp = 'fp-1', hostname = 'DEVBOX01') =>
  JSON.stringify({
    type: 'hello',
    v: 1,
    machine: { fingerprint: fp, hostname, os: 'win32', arch: 'x64', runner: '0.1.0' },
  });

beforeEach(async () => {
  __resetUpgradeHandlersForTest();
  __resetRunnersForTest();
  fakeMachines.clear();
  pendingSeen.length = 0;
  server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  setupWebSocket(server, { onInbound: async () => {} } as never, async (req) => {
    const a = await fakeAuth(req);
    return a.ok ? { userId: a.userId, displayName: a.displayName } : null;
  });
  setupRunnerWebSocket({
    registry: fakeRegistry,
    onPending: async (m) => {
      pendingSeen.push(m.fingerprint);
    },
    onApproved: async () => {},
    authenticate: fakeAuth,
    keepaliveMs: 120,
    maxPayload: TEST_MAX_PAYLOAD,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  base = `ws://127.0.0.1:${addr.port}`;
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  __resetRunnersForTest();
  fakeMachines.clear();
  pendingSeen.length = 0;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('runner endpoint', () => {
  it('refuses an unauthenticated upgrade with 401', async () => {
    expect(await rejectedWith(open(RUNNER_WS_PATH))).toBe(401);
  });

  it('admits a person by any personal source: a verified Entra token, Tailscale, or proxy headers', async () => {
    for (const who of ['oidc', 'tailscale', 'proxy']) {
      const ws = open(RUNNER_WS_PATH, who);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('unexpected-response', (_req, res) => reject(new Error(`${who}: HTTP ${res.statusCode}`)));
        ws.once('error', reject);
      });
      ws.close();
    }
  });

  it('refuses an identity that names no person (the shared bearer token) with 403', async () => {
    expect(await rejectedWith(open(RUNNER_WS_PATH, 'bearer'))).toBe(403);
    expect(listRunners()).toHaveLength(0);
  });

  it('admits an oidc identity, requires hello first, then welcomes it and lists the machine', async () => {
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    ws.send(JSON.stringify({ type: 'ping', t: 1 }));
    expect((await nextFrame(ws)).code).toBe('hello-first');
    ws.send(hello());
    const w = await nextFrame(ws);
    expect(w.type).toBe('welcome');
    expect(w.userId).toBe('webchat:jane.doe@example.com');
    expect(w.keepaliveMs).toBe(120);
    const [r] = listRunners();
    expect(r).toMatchObject({
      fingerprint: 'fp-1',
      hostname: 'DEVBOX01',
      userId: 'webchat:jane.doe@example.com',
      os: 'win32',
    });
  });

  it('the frame ceiling is generous enough for mailbox rows (256 KB was hit in the field)', () => {
    expect(MAX_PAYLOAD).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it('an oversized frame closes that link only — it never takes central down', async () => {
    const onUncaught = (e: unknown) => {
      throw new Error(`uncaught: ${String(e)}`);
    };
    process.once('uncaughtException', onUncaught);
    try {
      const ws = open(RUNNER_WS_PATH, 'oidc');
      await opened(ws);
      ws.send(hello());
      await nextFrame(ws);
      const closed = new Promise<void>((r) => ws.once('close', () => r()));
      ws.send(Buffer.alloc(TEST_MAX_PAYLOAD + 1, 0x61)); // one byte over
      await closed;
      // Central still takes new links.
      const again = open(RUNNER_WS_PATH, 'oidc');
      await opened(again);
      again.send(hello('fp-2'));
      expect((await nextFrame(again)).type).toBe('welcome');
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  it('rejects a hello without a fingerprint or with the wrong protocol version', async () => {
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    ws.send(JSON.stringify({ type: 'hello', v: 99, machine: { fingerprint: 'x' } }));
    expect((await nextFrame(ws)).code).toBe('bad-hello');
    await new Promise<void>((r) => ws.once('close', () => r()));
    expect(listRunners()).toHaveLength(0);
  });

  it('keeps a responsive runner alive and drops one that stops answering', async () => {
    const good = open(RUNNER_WS_PATH, 'oidc');
    await opened(good);
    good.send(hello('fp-good'));
    await nextFrame(good);
    good.on('message', (d) => {
      const f = JSON.parse(String(d));
      if (f.type === 'ping') good.send(JSON.stringify({ type: 'pong', t: f.t }));
    });

    const mute = open(RUNNER_WS_PATH, 'oidc');
    await opened(mute);
    mute.send(hello('fp-mute'));
    await nextFrame(mute);
    const muteClosed = new Promise<void>((r) => mute.once('close', () => r()));

    await muteClosed; // two intervals without a pong → terminated
    // The server's own close handler removes it — and detaches the link.
    await vi.waitFor(() => expect(listRunners().map((r) => r.fingerprint)).not.toContain('fp-mute'), { interval: 5 });
    expect(listRunners().map((r) => r.fingerprint)).toEqual(['fp-good']);
    expect(isRunnerConnected('fp-mute')).toBe(false);
  });

  it('refuses a fingerprint that is not a plain id', async () => {
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    ws.send(
      JSON.stringify({
        type: 'hello',
        v: RUNNER_PROTOCOL_VERSION,
        machine: { fingerprint: 'x" onmouseover="alert(1)' },
      }),
    );
    expect((await nextFrame(ws)).code).toBe('bad-hello');
    await new Promise<void>((r) => ws.once('close', () => r()));
    expect(listRunners()).toHaveLength(0);
  });

  it('a reconnecting machine supersedes its own stale socket', async () => {
    const a = open(RUNNER_WS_PATH, 'oidc');
    await opened(a);
    a.send(hello('fp-same'));
    await nextFrame(a);
    const aClosed = new Promise<void>((r) => a.once('close', () => r()));
    const b = open(RUNNER_WS_PATH, 'oidc');
    await opened(b);
    // Answer the keepalive, as a real runner does. This suite's keepalive is
    // 120 ms, and a runner silent for two intervals is dropped by design; on a
    // loaded CI runner the wait for A's close below outlasted that, so the
    // server correctly dropped B and the assertion saw no runner at all.
    answerPings(b);
    b.send(hello('fp-same'));
    await nextFrame(b);
    await aClosed;
    expect(listRunners()).toHaveLength(1);
  });

  it('the chat endpoint /ws is still dispatched, and an unknown path is still destroyed', async () => {
    // An unauthenticated /ws upgrade is answered with HTTP 401 by the chat
    // handler — proof the path still reaches it (a destroyed socket produces
    // no HTTP response at all). This deliberately stops short of a successful
    // chat connection, whose handler needs the full webchat schema.
    expect(await rejectedWith(open('/ws'))).toBe(401);
    expect(await rejectedWith(open('/nope', 'oidc'))).toBe(0); // destroyed without an HTTP response
  });
  it('the /runner/ws alias reaches the same handler (proxies that upgrade every path)', async () => {
    const ws = open('/runner/ws', 'oidc');
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.close();
    expect(RUNNER_WS_PATH).toBe('/ws/runner');
  });
  it('a pending machine is welcomed with pairing=pending and the pairing hook fires once', async () => {
    fakeMachines.set('fp-new', {
      fingerprint: 'fp-new',
      user_id: 'webchat:jane.doe@example.com',
      hostname: 'h',
      os: 'win32',
      arch: 'x64',
      runner_version: 'v',
      status: 'pending',
      approval_id: null,
      approved_by: null,
      approved_at: null,
      revoked_by: null,
      revoked_at: null,
      first_seen: 1,
      last_seen: 1,
    });
    const ws = open(RUNNER_WS_PATH, 'oidc');
    const welcome = await new Promise<Record<string, unknown>>((r) => {
      ws.once('open', () =>
        ws.send(
          JSON.stringify({
            type: 'hello',
            v: 1,
            machine: { fingerprint: 'fp-new', hostname: 'h', os: 'win32', arch: 'x64', runner: 'v' },
          }),
        ),
      );
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        if (f.type === 'welcome') r(f);
      });
    });
    expect(welcome.pairing).toBe('pending');
    expect(pendingSeen).toEqual(['fp-new']);
    expect(listRunners()[0]?.pairing).toBe('pending');
    ws.close();
  });
  it('a revoked machine is refused with 4403 and audited; approval pushes a pairing frame', async () => {
    fakeMachines.set('fp-rev', {
      fingerprint: 'fp-rev',
      user_id: 'webchat:jane.doe@example.com',
      hostname: 'h',
      os: 'linux',
      arch: 'x64',
      runner_version: 'v',
      status: 'revoked',
      approval_id: null,
      approved_by: null,
      approved_at: null,
      revoked_by: 'webchat:owner',
      revoked_at: 1,
      first_seen: 1,
      last_seen: 1,
    });
    const ws = open(RUNNER_WS_PATH, 'oidc');
    const closed = await new Promise<{ code: number; error?: string }>((r) => {
      let error: string | undefined;
      ws.once('open', () =>
        ws.send(
          JSON.stringify({
            type: 'hello',
            v: 1,
            machine: { fingerprint: 'fp-rev', hostname: 'h', os: 'linux', arch: 'x64', runner: 'v' },
          }),
        ),
      );
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        if (f.type === 'error') error = f.code;
      });
      ws.on('close', (code) => r({ code, error }));
    });
    expect(closed).toEqual({ code: 4403, error: 'machine-revoked' });
    expect(applyPairingChange('fp-rev', 'approved')).toBe(false); // nothing live to notify

    fakeMachines.set('fp-pend', {
      fingerprint: 'fp-pend',
      user_id: 'webchat:jane.doe@example.com',
      hostname: 'h',
      os: 'linux',
      arch: 'x64',
      runner_version: 'v',
      status: 'pending',
      approval_id: null,
      approved_by: null,
      approved_at: null,
      revoked_by: null,
      revoked_at: null,
      first_seen: 1,
      last_seen: 1,
    });
    const ws2 = open(RUNNER_WS_PATH, 'oidc');
    const frame = await new Promise<Record<string, unknown>>((r) => {
      ws2.once('open', () =>
        ws2.send(
          JSON.stringify({
            type: 'hello',
            v: 1,
            machine: { fingerprint: 'fp-pend', hostname: 'h', os: 'linux', arch: 'x64', runner: 'v' },
          }),
        ),
      );
      ws2.on('message', (d) => {
        const f = JSON.parse(String(d));
        if (f.type === 'welcome') expect(applyPairingChange('fp-pend', 'approved')).toBe(true);
        if (f.type === 'pairing') r(f);
      });
    });
    expect(frame.status).toBe('approved');
    expect(listRunners().find((r) => r.fingerprint === 'fp-pend')?.pairing).toBe('approved');
    ws2.close();
  });
});
