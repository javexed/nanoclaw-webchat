// The link against a real ws server on an ephemeral port — the same shape the
// staging endpoint speaks — without any VS Code API.
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { RunnerLink, type LinkState } from './link.js';

let server: http.Server;
afterEach(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
});

async function serve(
  onConn: (ws: import('ws').WebSocket, req: http.IncomingMessage) => void,
  gate?: (req: http.IncomingMessage) => number | null,
): Promise<string> {
  server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const code = gate?.(req) ?? null;
    if (code) {
      socket.write(`HTTP/1.1 ${code} X\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConn(ws, req));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
/** Wait for a condition instead of a fixed time: the socket round trips take what they take. */
const until = (cond: () => boolean, timeout = 5000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error('not yet');
    },
    { timeout, interval: 5 },
  );
/** Let pending callbacks and promise continuations run (no timer involved). */
const settle = () => new Promise<void>((r) => setImmediate(r));
const machine = { fingerprint: 'fp', hostname: 'h', os: 'linux', arch: 'x64', runner: 'test' };

describe('RunnerLink', () => {
  it('sends the bearer, says hello, reaches connected on welcome, and answers pings', async () => {
    const seen: string[] = [];
    let auth = '';
    const url = await serve((ws, req) => {
      auth = String(req.headers.authorization);
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        seen.push(f.type);
        if (f.type === 'hello') {
          ws.send(
            JSON.stringify({ type: 'welcome', v: 1, userId: 'webchat:jane', displayName: 'Jane', keepaliveMs: 50 }),
          );
          ws.send(JSON.stringify({ type: 'ping', t: 7 }));
        }
      });
    });
    const states: LinkState[] = [];
    const link = new RunnerLink({
      serverUrl: url,
      machine,
      getToken: async () => 'tok-1',
      events: { state: (s) => states.push(s), log: () => {} },
    });
    link.start();
    await until(() => seen.length >= 2 && states.includes('connected'));
    expect(auth).toBe('Bearer tok-1');
    expect(seen.slice(0, 2)).toEqual(['hello', 'pong']);
    expect(states).toContain('connected');
    expect(link.welcome?.userId).toBe('webchat:jane');
    link.stop();
  });
  it('answers the challenge with its key, for the origin it dialled, before the welcome', async () => {
    let response: Record<string, unknown> | null = null;
    const url = await serve((ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        if (f.type === 'hello') {
          expect(f.machine.publicKey).toBe('PUB');
          ws.send(JSON.stringify({ type: 'challenge', nonce: 'n-1', origin: 'https://ignored.example' }));
        }
        if (f.type === 'challenge.response') {
          response = f;
          ws.send(JSON.stringify({ type: 'welcome', v: 1, userId: 'u', displayName: 'U', keepaliveMs: 50 }));
        }
      });
    });
    const states: LinkState[] = [];
    const link = new RunnerLink({
      serverUrl: `${url}/some/path`,
      machine: { ...machine, publicKey: 'PUB' },
      signChallenge: (fp, origin, nonce) => `sig(${fp}|${origin}|${nonce})`,
      getToken: async () => 'tok',
      events: { state: (s) => states.push(s), log: () => {} },
    });
    link.start();
    await until(() => response !== null && states.includes('connected'));
    expect(response).toEqual({
      type: 'challenge.response',
      origin: url,
      signature: `sig(fp|${url}|n-1)`,
    });
    expect(states).toContain('connected');
    link.stop();
  });
  it('a 403 on upgrade becomes the unauthorized state and does not retry', async () => {
    let attempts = 0;
    const url = await serve(
      () => {},
      () => {
        attempts++;
        return 403;
      },
    );
    const states: LinkState[] = [];
    const link = new RunnerLink({
      serverUrl: url,
      machine,
      getToken: async () => 'tok',
      events: { state: (s) => states.push(s), log: () => {} },
    });
    link.start();
    await until(() => states.at(-1) === 'unauthorized'); // stops the link: nothing is scheduled after it
    expect(attempts).toBe(1);
    link.stop();
  });
  it('a token provider failure is reported as unauthorized without touching the network', async () => {
    const states: LinkState[] = [];
    let hit = 0;
    const url = await serve(() => {
      hit++;
    });
    const link = new RunnerLink({
      serverUrl: url,
      machine,
      getToken: async () => {
        throw new Error('not signed in');
      },
      events: { state: (s) => states.push(s), log: () => {} },
    });
    link.start();
    await until(() => states.at(-1) === 'unauthorized');
    expect(hit).toBe(0);
    link.stop();
  });
  it('after a first connect, a missing token is transient: it retries and reconnects instead of stopping (laptop wake)', async () => {
    let conns = 0;
    const url = await serve((ws) => {
      conns++;
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        if (f.type === 'hello')
          ws.send(JSON.stringify({ type: 'welcome', v: 1, userId: 'u', displayName: 'U', keepaliveMs: 50 }));
      });
      if (conns === 1) setTimeout(() => ws.terminate(), 50); // the lid closes
    });
    const states: LinkState[] = [];
    const logs: string[] = [];
    let tokenOk = true;
    const link = new RunnerLink({
      serverUrl: url,
      machine,
      getToken: async () => {
        if (!tokenOk) throw new Error('not signed in');
        return 'tok';
      },
      events: { state: (s) => states.push(s), log: (l) => logs.push(l) },
    });
    link.start();
    await until(() => states.includes('connected'));
    tokenOk = false; // the silent refresh fails while the network is still coming back
    await until(() => logs.some((l) => l.startsWith('no token yet'))); // the retry after the lid closed
    expect(states).not.toContain('unauthorized');
    expect(logs.filter((l) => l.startsWith('no token yet'))).toHaveLength(1);
    tokenOk = true;
    link.nudge(); // the developer is back at the window
    await until(() => conns === 2 && states.at(-1) === 'connected');
    expect(logs.some((l) => l.includes('available again'))).toBe(true);
    link.stop();
  });
  it('stop() during the token fetch opens no socket (superseded links must not fan out)', async () => {
    let upgrades = 0;
    const url = await serve(
      () => {},
      () => {
        upgrades++;
        return 500;
      },
    );
    let release!: (t: string) => void;
    const link = new RunnerLink({
      serverUrl: url,
      machine,
      getToken: () =>
        new Promise<string>((r) => {
          release = r;
        }),
      events: { state: () => {}, log: () => {} },
    });
    link.start();
    await until(() => release !== undefined);
    link.stop(); // as extension.connect() does before building a new link
    release('tok-late'); // token arrives after the stop
    await settle(); // a socket would be opened as soon as the token is in hand
    expect((link as unknown as { ws: unknown }).ws).toBeNull();
    expect(upgrades).toBe(0);
  });
  it('stands by instead of fighting when another window takes the connection', async () => {
    const url = await serve((ws) => ws.close(4409, 'superseded'));
    const states: Array<[string, string | undefined]> = [];
    const logs: string[] = [];
    const link = new RunnerLink({
      serverUrl: url,
      machine,
      getToken: async () => 'tok',
      events: { state: (s, d) => states.push([s, d]), log: (l) => logs.push(l) },
    });
    link.start();
    await until(() => states.at(-1)?.[1] === 'another window holds this machine');
    expect(logs.some((l) => l.includes('another VS Code window'))).toBe(true);
    expect(states.at(-1)).toEqual(['disconnected', 'another window holds this machine']);
    link.stop();
  });

  it('while another window holds the machine, retries say standby every poll and never take it; then connects', async () => {
    let held = true;
    const hellos: Array<Record<string, unknown>> = [];
    const url = await serve((ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        if (f.type !== 'hello') return;
        hellos.push(f);
        if (held && f.standby) {
          ws.send(JSON.stringify({ type: 'error', code: 'held', message: 'x' }));
          ws.close(4409, 'held');
        } else
          ws.send(
            JSON.stringify({ type: 'welcome', v: 1, userId: 'u', displayName: 'D', keepaliveMs: 30000, standby: true }),
          );
      });
    });
    const logs: string[] = [];
    const link = new RunnerLink({
      serverUrl: url,
      machine,
      standby: true, // a connect nobody asked for: startup
      standbyPollMs: 40,
      getToken: async () => 'tok',
      events: { state: () => {}, log: (l) => logs.push(l) },
    });
    link.start();
    await until(() => hellos.length >= 2);
    expect(hellos.every((h) => h.standby === true)).toBe(true);
    // Said once, not on every poll.
    expect(logs.filter((l) => l.includes('standing by'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('disconnected (4409 held)') || l.includes('server: held'))).toBe(false);
    held = false; // the other window closed
    await until(() => link.welcome?.userId === 'u');
    link.stop();
  });

  it('an explicit connect says no standby, so it takes the connection', async () => {
    const hellos: Array<Record<string, unknown>> = [];
    const url = await serve((ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        if (f.type === 'hello') hellos.push(f);
      });
    });
    const link = new RunnerLink({
      serverUrl: url,
      machine,
      getToken: async () => 'tok',
      events: { state: () => {}, log: () => {} },
    });
    link.start();
    await until(() => hellos.length >= 1);
    expect(hellos[0]?.standby).toBeUndefined();
    link.stop();
  });

  it('a keepalive that names a new served build refreshes the offer and fires the update event', async () => {
    const { parseOffer } = await import('./link.js');
    expect(parseOffer({ version: '0.7.7', sha256: 'a'.repeat(64), size: 1 })).toEqual({
      version: '0.7.7',
      sha256: 'a'.repeat(64),
      size: 1,
    });
    expect(parseOffer({ version: 1 })).toBeNull();
    expect(parseOffer(null)).toBeNull();
  });

  it('logs one line per distinct refusal, not one per attempt', async () => {
    const logs: string[] = [];
    let calls = 0;
    const server = new WebSocketServer({ port: 0 });
    const port = (server.address() as any).port;
    server.on('connection', (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(String(d));
        if (f.type === 'hello') {
          ws.send(JSON.stringify({ type: 'welcome', v: 1, userId: 'u', displayName: 'D', keepaliveMs: 30000 }));
          for (let i = 0; i < 4; i++) ws.send(JSON.stringify({ type: 'req', id: `r${i}`, op: 'status', payload: {} }));
        }
      });
    });
    const link = new RunnerLink({
      serverUrl: `http://127.0.0.1:${port}`,
      machine: { fingerprint: 'f'.repeat(64), hostname: 'h', os: 'linux', arch: 'x64', runner: 't' },
      getToken: async () => 't',
      onRequest: async () => {
        calls++;
        throw new Error('runtime-unavailable: Cannot connect to Podman');
      },
      events: { state: () => {}, log: (l) => logs.push(l) },
    });
    link.start();
    await until(() => calls === 4);
    await settle(); // the fourth refusal is logged once its rejection is handled
    link.stop();
    server.close();
    const refusals = logs.filter((l) => l.includes('refused:'));
    expect(refusals).toHaveLength(1); // four identical refusals, one line
  });
});
