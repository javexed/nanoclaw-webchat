/**
 * Runner endpoint — admission, hello/welcome, keepalive, coexistence with /ws.
 * A real http.Server on an ephemeral port and a real `ws` client; auth is a
 * header-driven fake so the OIDC bar can be exercised without tokens.
 */
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'crypto';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { AuthFailure, AuthResult } from './auth.js';
import {
  MAX_PAYLOAD,
  configuredOriginHosts,
  machineKeyMessage,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_WS_PATH,
  __resetRunnersForTest,
  applyPairingChange,
  listRunners,
  setupRunnerWebSocket,
} from './runner-ws.js';
import type { RunnerMachineRow, RunnerRegistryPort } from './runner-registry.js';
import { isRunnerConnected } from './runner-transport.js';

const audits = vi.hoisted(() => [] as Array<{ type: string; detail?: Record<string, unknown> }>);
vi.mock('../../audit.js', () => ({ audit: (e: { type: string }) => audits.push(e) }));
// The agents placed on a machine run on central; stopping them is runner-tools' part.
const stopAgentsPlacedOn = vi.hoisted(() => vi.fn(async (_fp: string, _reason: string) => 2));
vi.mock('./runner-tools.js', () => ({ stopAgentsPlacedOn }));
// No tailscale here: the tailnet names central answers to are set per test.
const tailnetNames = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('./request-guard.js', async (orig) => ({
  ...(await orig<typeof import('./request-guard.js')>()),
  tailnetHostNames: async () => tailnetNames.names,
}));
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
      public_key: prev ? prev.public_key : (seen.publicKey ?? null),
      keyless_allowed: prev?.keyless_allowed ?? 0,
    };
    fakeMachines.set(seen.fingerprint, row);
    return row;
  },
  async getMachine(fp) {
    return fakeMachines.get(fp);
  },
  async bindMachineKey(fp, publicKey) {
    const row = fakeMachines.get(fp);
    if (!row || row.public_key) return false;
    row.public_key = publicKey;
    row.keyless_allowed = 0;
    return true;
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
/** The first `welcome` frame, skipping keepalive pings that may come before it. */
const welcomed = (ws: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    const onMessage = (d: WebSocket.RawData): void => {
      const f = JSON.parse(String(d)) as Record<string, unknown>;
      if (f.type !== 'welcome') return;
      ws.off('message', onMessage);
      resolve(f);
    };
    ws.on('message', onMessage);
  });
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
interface TestKey {
  pub: string;
  privateKey: KeyObject;
}
function newKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
}
const machineKey = newKey();
const hello = (fp = 'fp-1', hostname = 'DEVBOX01', pub: string | null = machineKey.pub) =>
  JSON.stringify({
    type: 'hello',
    v: 1,
    machine: {
      fingerprint: fp,
      hostname,
      os: 'win32',
      arch: 'x64',
      runner: '0.1.0',
      ...(pub ? { publicKey: pub } : {}),
    },
  });
/** The next frame of one type, skipping keepalive pings and anything else. */
const frameOf = (ws: WebSocket, type: string): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    const onMessage = (d: WebSocket.RawData): void => {
      const f = JSON.parse(String(d)) as Record<string, unknown>;
      if (f.type !== type) return;
      ws.off('message', onMessage);
      resolve(f);
    };
    ws.on('message', onMessage);
  });
const originOf = (): string => base.replace(/^ws:/, 'http:');
const signed = (key: TestKey, fp: string, origin: string, nonce: string): string =>
  edSign(null, Buffer.from(machineKeyMessage(fp, origin, nonce)), key.privateKey).toString('base64');
/** Say a keyed hello and answer central's challenge, as the extension does. Resolves with the signature sent. */
async function sayHello(
  ws: WebSocket,
  fp = 'fp-1',
  opts: { key?: TestKey; signWith?: TestKey; origin?: string; signature?: string } = {},
): Promise<string> {
  const key = opts.key ?? machineKey;
  ws.send(hello(fp, 'DEVBOX01', key.pub));
  const c = await frameOf(ws, 'challenge');
  const origin = opts.origin ?? originOf();
  const signature = opts.signature ?? signed(opts.signWith ?? key, fp, origin, String(c.nonce));
  ws.send(JSON.stringify({ type: 'challenge.response', origin, signature }));
  return signature;
}
const closedWith = (ws: WebSocket): Promise<{ code: number; error?: string }> =>
  new Promise((r) => {
    let error: string | undefined;
    ws.on('message', (d) => {
      const f = JSON.parse(String(d));
      if (f.type === 'error') error = f.code;
    });
    ws.on('close', (code) => r({ code, error }));
  });

/**
 * Every test but the keepalive one holds sockets open across awaits, and is
 * not about keepalive: at a short interval a loaded CI worker, stalling its
 * event loop, could drop a runner that IS answering, and a test about
 * something else went red. They run at a keepalive too long to fire; the
 * keepalive test re-registers the endpoint at a short one for itself.
 */
const KEEPALIVE_MS = 30_000;
function setupRunner(keepaliveMs: number): void {
  setupRunnerWebSocket({
    registry: fakeRegistry,
    onPending: async (m) => {
      pendingSeen.push(m.fingerprint);
    },
    onApproved: async () => {},
    authenticate: fakeAuth,
    keepaliveMs,
    maxPayload: TEST_MAX_PAYLOAD,
  });
}

beforeEach(async () => {
  __resetUpgradeHandlersForTest();
  __resetRunnersForTest();
  fakeMachines.clear();
  pendingSeen.length = 0;
  audits.length = 0;
  server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  setupWebSocket(server, { onInbound: async () => {} } as never, async (req) => {
    const a = await fakeAuth(req);
    return a.ok ? { userId: a.userId, displayName: a.displayName } : null;
  });
  setupRunner(KEEPALIVE_MS);
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
    await sayHello(ws);
    const w = await nextFrame(ws);
    expect(w.type).toBe('welcome');
    expect(w.userId).toBe('webchat:jane.doe@example.com');
    expect(w.keepaliveMs).toBe(KEEPALIVE_MS);
    const [r] = listRunners();
    expect(r).toMatchObject({
      fingerprint: 'fp-1',
      hostname: 'DEVBOX01',
      userId: 'webchat:jane.doe@example.com',
      os: 'win32',
    });
  });

  it('the frame ceiling is generous enough for a large file read through the laptop tools (256 KB was hit in the field)', () => {
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
      await sayHello(ws);
      await nextFrame(ws);
      const closed = new Promise<void>((r) => ws.once('close', () => r()));
      ws.send(Buffer.alloc(TEST_MAX_PAYLOAD + 1, 0x61)); // one byte over
      await closed;
      // Central still takes new links.
      const again = open(RUNNER_WS_PATH, 'oidc');
      await opened(again);
      await sayHello(again, 'fp-2');
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
    // The one test about keepalive: re-register the endpoint at a short interval.
    __resetUpgradeHandlersForTest();
    __resetRunnersForTest();
    setupRunner(150);
    const good = open(RUNNER_WS_PATH, 'oidc');
    await opened(good);
    // Answering from the first frame: a ping can arrive before the welcome,
    // and on a loaded runner one left unanswered got the good runner dropped too.
    answerPings(good);
    await sayHello(good, 'fp-good');
    await welcomed(good);

    const mute = open(RUNNER_WS_PATH, 'oidc');
    await opened(mute);
    await sayHello(mute, 'fp-mute');
    await welcomed(mute);
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
    // Both sockets answer the keepalive, as a real runner does, so A's close
    // can only mean "superseded by B".
    answerPings(a);
    await sayHello(a, 'fp-same');
    await welcomed(a);
    const aClosed = new Promise<void>((r) => a.once('close', () => r()));
    const b = open(RUNNER_WS_PATH, 'oidc');
    await opened(b);
    answerPings(b);
    await sayHello(b, 'fp-same');
    // B's own welcome, not just its first frame: that can be a ping, which
    // arrives before B is registered.
    await welcomed(b);
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
      public_key: null,
      keyless_allowed: 1, // paired before keys existed
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
      public_key: null,
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
      public_key: null,
      keyless_allowed: 1, // paired before keys existed
    });
    const ws2 = open(RUNNER_WS_PATH, 'oidc');
    answerPings(ws2); // held open across the approval: it must stay alive
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

describe('machine key', () => {
  const row = (fp: string, over: Partial<RunnerMachineRow> = {}): RunnerMachineRow => ({
    fingerprint: fp,
    user_id: 'webchat:jane.doe@example.com',
    hostname: 'h',
    os: 'linux',
    arch: 'x64',
    runner_version: 'v',
    status: 'approved',
    approval_id: null,
    approved_by: 'webchat:owner',
    approved_at: 1,
    revoked_by: null,
    revoked_at: null,
    first_seen: 1,
    last_seen: 1,
    public_key: null,
    ...over,
  });
  const auditsOf = (type: string) => audits.filter((a) => a.type === type);

  it('a new machine proves its key and is recorded with it', async () => {
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    await sayHello(ws, 'fp-keyed');
    expect((await frameOf(ws, 'welcome')).pairing).toBe('approved');
    expect(fakeMachines.get('fp-keyed')?.public_key).toBe(machineKey.pub);
    expect(auditsOf('runner.connect')[0]?.detail?.keyed).toBe(true);
  });

  it('a new machine without a key is refused and not recorded', async () => {
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    const closed = closedWith(ws);
    ws.send(hello('fp-bare', 'h', null));
    expect(await closed).toEqual({ code: 4403, error: 'machine-key-required' });
    expect(fakeMachines.has('fp-bare')).toBe(false);
  });

  it('a forged signature (another key) is refused and audited', async () => {
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    const closed = closedWith(ws);
    await sayHello(ws, 'fp-forged', { signWith: newKey() });
    expect(await closed).toEqual({ code: 4403, error: 'machine-key-mismatch' });
    expect(fakeMachines.has('fp-forged')).toBe(false);
    expect(auditsOf('runner.machine.key.mismatch')[0]?.detail).toMatchObject({
      reason: 'bad-signature',
      fingerprint: 'fp-forged',
    });
    expect(listRunners()).toHaveLength(0);
  });

  it('a signature replayed for another challenge is refused', async () => {
    const first = open(RUNNER_WS_PATH, 'oidc');
    await opened(first);
    const signature = await sayHello(first, 'fp-replay');
    await frameOf(first, 'welcome');
    first.close();
    const again = open(RUNNER_WS_PATH, 'oidc');
    await opened(again);
    const closed = closedWith(again);
    await sayHello(again, 'fp-replay', { signature });
    expect(await closed).toEqual({ code: 4403, error: 'machine-key-mismatch' });
    expect(auditsOf('runner.machine.key.mismatch')[0]?.detail?.reason).toBe('bad-signature');
  });

  describe('the origin a machine signed for', () => {
    afterEach(() => {
      delete process.env.WEBCHAT_PUBLIC_URL;
      delete process.env.WEBCHAT_RUNNER_ORIGINS;
      tailnetNames.names = [];
    });

    it('another origin (a relaying server) is refused', async () => {
      process.env.WEBCHAT_PUBLIC_URL = 'https://central.example.test';
      const ws = open(RUNNER_WS_PATH, 'oidc');
      await opened(ws);
      const closed = closedWith(ws);
      await sayHello(ws, 'fp-relayed', { origin: 'https://elsewhere.example' });
      expect(await closed).toEqual({ code: 4403, error: 'machine-key-mismatch' });
      expect(auditsOf('runner.machine.key.mismatch')[0]?.detail?.reason).toBe('origin-mismatch');
    });

    it("is never taken from the request's X-Forwarded-Host (or Host): a relay sets it to its own name", async () => {
      process.env.WEBCHAT_PUBLIC_URL = 'https://central.example.test';
      const ws = new WebSocket(`${base}${RUNNER_WS_PATH}`, {
        headers: { 'x-test-auth': 'oidc', 'x-forwarded-host': 'phish.example' },
      });
      sockets.push(ws);
      await opened(ws);
      const closed = closedWith(ws);
      await sayHello(ws, 'fp-phished', { origin: 'https://phish.example' });
      expect(await closed).toEqual({ code: 4403, error: 'machine-key-mismatch' });
      expect(fakeMachines.get('fp-phished')?.public_key ?? null).toBeNull();
    });

    it("central's configured names are accepted: its public URL, WEBCHAT_RUNNER_ORIGINS, its tailnet name", async () => {
      process.env.WEBCHAT_PUBLIC_URL = 'https://central.example.test';
      process.env.WEBCHAT_RUNNER_ORIGINS = 'https://alt.example.test:8443, lan.example.test';
      tailnetNames.names = ['box.tail0000.ts.net', 'box'];
      expect(await configuredOriginHosts()).toEqual([
        'central.example.test',
        'alt.example.test:8443',
        'lan.example.test',
        'box.tail0000.ts.net',
        'box',
      ]);
      // A name without a port matches on any port: Tailscale Serve puts installs on :443 and :8443 alike.
      const origins = [
        'https://central.example.test',
        'https://box.tail0000.ts.net',
        'https://box.tail0000.ts.net:8443',
      ];
      for (const [i, origin] of origins.entries()) {
        const ws = open(RUNNER_WS_PATH, 'oidc');
        await opened(ws);
        await sayHello(ws, `fp-ok-${i}`, { origin });
        await frameOf(ws, 'welcome');
        ws.close();
      }
    });

    it('with no address configured, only a machine on this host can prove its key, and the refusal says why', async () => {
      const ws = open(RUNNER_WS_PATH, 'oidc');
      await opened(ws);
      const closed = closedWith(ws);
      const errors: string[] = [];
      ws.on('message', (d) => {
        const f = JSON.parse(String(d)) as { type: string; message?: string };
        if (f.type === 'error' && f.message) errors.push(f.message);
      });
      await sayHello(ws, 'fp-unconf', { origin: 'https://central.example.test' });
      expect(await closed).toEqual({ code: 4403, error: 'machine-key-mismatch' });
      expect(auditsOf('runner.machine.key.mismatch')[0]?.detail?.reason).toBe('origin-unconfigured');
      expect(errors.join(' ')).toMatch(/WEBCHAT_PUBLIC_URL/);
    });
  });

  it('transition: a keyless approved machine binds the first key it proves; after that the key is required and fixed', async () => {
    fakeMachines.set('fp-old', row('fp-old', { keyless_allowed: 1 }));
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    await sayHello(ws, 'fp-old');
    await frameOf(ws, 'welcome');
    expect(fakeMachines.get('fp-old')?.public_key).toBe(machineKey.pub);
    expect(auditsOf('runner.machine.key.bound')).toHaveLength(1);
    ws.close();

    // An old extension (no key) on the now-bound machine.
    const bare = open(RUNNER_WS_PATH, 'oidc');
    await opened(bare);
    const bareClosed = closedWith(bare);
    bare.send(hello('fp-old', 'h', null));
    expect(await bareClosed).toEqual({ code: 4403, error: 'machine-key-mismatch' });

    // A different key, correctly signed.
    const other = open(RUNNER_WS_PATH, 'oidc');
    await opened(other);
    const otherClosed = closedWith(other);
    other.send(hello('fp-old', 'h', newKey().pub));
    expect(await otherClosed).toEqual({ code: 4403, error: 'machine-key-mismatch' });
    expect(auditsOf('runner.machine.key.mismatch').map((a) => a.detail?.reason)).toEqual(['no-key', 'different-key']);
    expect(fakeMachines.get('fp-old')?.public_key).toBe(machineKey.pub);
  });

  it('transition: a keyless approved machine on an old extension still connects, and is logged', async () => {
    fakeMachines.set('fp-legacy', row('fp-legacy', { keyless_allowed: 1 }));
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    ws.send(hello('fp-legacy', 'h', null));
    expect((await frameOf(ws, 'welcome')).pairing).toBe('approved');
    expect(auditsOf('runner.machine.keyless')[0]?.detail?.fingerprint).toBe('fp-legacy');
    expect(fakeMachines.get('fp-legacy')?.public_key).toBeNull();
  });

  it('a machine revoked and approved again must bring a key: revoking does not reopen keyless entry', async () => {
    // What revoke leaves (key cleared, keyless not allowed), then approved again.
    fakeMachines.set('fp-reapproved', row('fp-reapproved', { keyless_allowed: 0 }));
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    const closed = closedWith(ws);
    ws.send(hello('fp-reapproved', 'h', null));
    expect(await closed).toEqual({ code: 4403, error: 'machine-key-required' });
    expect(auditsOf('runner.machine.keyless')).toHaveLength(0);
    expect(auditsOf('runner.refused')[0]?.detail).toMatchObject({ reason: 'machine-key-required', known: true });
  });

  it('a keyless connection loses to a key bound meanwhile', async () => {
    const legacy = row('fp-race', { keyless_allowed: 1 });
    fakeMachines.set('fp-race', legacy);
    // Between the hello's check and admission, another connection binds a key.
    const seen = fakeRegistry.recordMachineSeen.bind(fakeRegistry);
    fakeRegistry.recordMachineSeen = async (m) => {
      const r = await seen(m);
      r.public_key = machineKey.pub;
      return r;
    };
    try {
      const ws = open(RUNNER_WS_PATH, 'oidc');
      await opened(ws);
      const closed = closedWith(ws);
      ws.send(hello('fp-race', 'h', null));
      expect(await closed).toEqual({ code: 4403, error: 'machine-key-mismatch' });
      expect(auditsOf('runner.machine.key.mismatch')[0]?.detail?.reason).toBe('no-key');
    } finally {
      fakeRegistry.recordMachineSeen = seen;
    }
  });

  it('a key that is not Ed25519 is a bad hello', async () => {
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    ws.send(hello('fp-junk', 'h', Buffer.from('not a key').toString('base64')));
    expect((await nextFrame(ws)).code).toBe('bad-hello');
  });
});

describe('stop all, and revoke', () => {
  beforeEach(() => stopAgentsPlacedOn.mockClear());

  async function runner(fp: string) {
    const ws = open(RUNNER_WS_PATH, 'oidc');
    await opened(ws);
    await sayHello(ws, fp);
    const welcome = await frameOf(ws, 'welcome');
    return { ws, welcome };
  }

  it('the welcome names the install, so the extension refuses requests for any other', async () => {
    const { welcome } = await runner('fp-w');
    expect(typeof welcome.installSlug).toBe('string');
    expect(String(welcome.installSlug).length).toBeGreaterThan(0);
  });

  it('stopAll stops the agents placed on the machine, here on central, and audits it', async () => {
    const { ws } = await runner('fp-stop');
    ws.send(JSON.stringify({ type: 'stopAll', sessions: [] }));
    await vi.waitFor(() =>
      expect(audits.find((a) => a.type === 'runner.stop_all')?.detail).toMatchObject({ sessions: 2 }),
    );
    expect(stopAgentsPlacedOn).toHaveBeenCalledWith('fp-stop', 'developer stopped all agents');
  });

  it('revoking a connected machine stops its agents on central, then closes', async () => {
    const { ws } = await runner('fp-rev2');
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    const pairing = frameOf(ws, 'pairing');
    expect(applyPairingChange('fp-rev2', 'revoked')).toBe(true);
    expect((await pairing).status).toBe('revoked');
    expect(await closed).toBe(4403);
    expect(stopAgentsPlacedOn).toHaveBeenCalledWith('fp-rev2', 'machine revoked');
  });
});
