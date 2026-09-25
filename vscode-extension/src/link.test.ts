// The link against a real ws server on an ephemeral port — the same shape the
// staging endpoint speaks — without any VS Code API.
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
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
    await new Promise((r) => setTimeout(r, 200));
    expect(auth).toBe('Bearer tok-1');
    expect(seen.slice(0, 2)).toEqual(['hello', 'pong']);
    expect(states).toContain('connected');
    expect(link.welcome?.userId).toBe('webchat:jane');
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
    await new Promise((r) => setTimeout(r, 300));
    expect(states.at(-1)).toBe('unauthorized');
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
    await new Promise((r) => setTimeout(r, 100));
    expect(states.at(-1)).toBe('unauthorized');
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
    await new Promise((r) => setTimeout(r, 30));
    tokenOk = false; // the silent refresh fails while the network is still coming back
    await new Promise((r) => setTimeout(r, 1200));
    expect(states).not.toContain('unauthorized');
    expect(logs.filter((l) => l.startsWith('no token yet'))).toHaveLength(1);
    tokenOk = true;
    link.nudge(); // the developer is back at the window
    await new Promise((r) => setTimeout(r, 200));
    expect(conns).toBe(2);
    expect(states.at(-1)).toBe('connected');
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
    await new Promise((r) => setTimeout(r, 20));
    link.stop(); // as extension.connect() does before building a new link
    release('tok-late'); // token arrives after the stop
    await new Promise((r) => setTimeout(r, 100));
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
    await new Promise((r) => setTimeout(r, 200));
    expect(logs.some((l) => l.includes('another VS Code window'))).toBe(true);
    // A five-minute wait, not the one-second retry that made two windows trade forever.
    expect(logs.some((l) => /reconnecting in 300s/.test(l))).toBe(true);
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
        throw new Error('runtime-unavailable: Cannot connect to Podman');
      },
      events: { state: () => {}, log: (l) => logs.push(l) },
    });
    link.start();
    await new Promise((r) => setTimeout(r, 300));
    link.stop();
    server.close();
    const refusals = logs.filter((l) => l.includes('refused:'));
    expect(refusals).toHaveLength(1); // four identical refusals, one line
  });
});
