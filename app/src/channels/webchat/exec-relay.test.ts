import { execFile, execFileSync, spawnSync } from 'child_process';
import http from 'http';
import net, { type AddressInfo } from 'net';
import type { Duplex } from 'stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ATTACH_SCRIPT,
  ContainerRelay,
  NO_DAEMON_EXIT,
  __resetExecRelayForTest,
  daemonScript,
  registerRelayedContainer,
  relayReady,
  type RelayRuntime,
} from './exec-relay.js';

/** Plays the daemon's side of the pipe: what it would send, and what it received. */
class FakeRuntime implements RelayRuntime {
  daemons = 0;
  daemonUp = false;
  received: Array<Record<string, unknown>> = [];
  #toRelay: ((line: string) => void) | null = null;
  #end: ((code: number | null) => void) | null = null;

  async startDaemon(): Promise<void> {
    this.daemons++;
    this.daemonUp = true;
  }
  attach(_c: string, onLine: (line: string) => void) {
    let end!: (code: number | null) => void;
    const done = new Promise<number | null>((r) => (end = r));
    this.#end = end;
    if (!this.daemonUp) {
      setTimeout(() => end(NO_DAEMON_EXIT), 0);
    } else {
      this.#toRelay = onLine;
    }
    return {
      write: (line: string) => {
        for (const l of line.split('\n').filter(Boolean)) {
          const f = JSON.parse(l) as Record<string, unknown>;
          this.received.push(f);
          if (f.t === 'hello') setTimeout(() => onLine(JSON.stringify({ t: 'ready', v: 1, seq: 0, inSeq: 0 })), 0);
        }
      },
      kill: () => end(null),
      done,
    };
  }
  daemonSays(f: Record<string, unknown>): void {
    this.#toRelay?.(JSON.stringify(f));
  }
  dropPipe(): void {
    this.#end?.(0);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => __resetExecRelayForTest());

describe('ContainerRelay', () => {
  it('starts the daemon when there is none, then carries a stream both ways to the route', async () => {
    const rt = new FakeRuntime();
    const routed: Array<{ port: number; stream: Duplex }> = [];
    const relay = new ContainerRelay(
      'ncl-x',
      { ports: [10255], route: (port, stream) => routed.push({ port, stream }) },
      rt,
    );
    void relay.run();
    await new Promise((r) => setTimeout(r, 400));
    expect(rt.daemons).toBe(1);
    expect(relay.ready).toBe(true);

    rt.daemonSays({ t: 'open', id: 's0', port: 10255, seq: 1 });
    rt.daemonSays({ t: 'data', id: 's0', b64: Buffer.from('CONNECT a:443').toString('base64'), seq: 2 });
    await tick();
    expect(routed).toHaveLength(1);
    expect(routed[0].port).toBe(10255);
    const got: Buffer[] = [];
    routed[0].stream.on('data', (d: Buffer) => got.push(d));
    await tick();
    expect(Buffer.concat(got).toString()).toBe('CONNECT a:443');
    // Every daemon frame is acknowledged.
    expect(rt.received.filter((f) => f.t === 'ack').map((f) => f.seq)).toEqual([1, 2]);

    // The route answers: the bytes go back as a data frame for that stream.
    routed[0].stream.write('HTTP/1.1 200 OK\r\n\r\n');
    await tick();
    const back = rt.received.find((f) => f.t === 'data');
    expect(back?.id).toBe('s0');
    expect(Buffer.from(String(back?.b64), 'base64').toString()).toBe('HTTP/1.1 200 OK\r\n\r\n');

    // The agent closes: the route's end sees it.
    let ended = false;
    routed[0].stream.on('end', () => (ended = true));
    rt.daemonSays({ t: 'close', id: 's0', seq: 3 });
    await tick();
    expect(ended).toBe(true);
    expect(relay.streamCount).toBe(0);
    relay.close();
  });

  it('refuses a port it was not told about, and ignores a replayed frame', async () => {
    const rt = new FakeRuntime();
    rt.daemonUp = true;
    const routed: number[] = [];
    const relay = new ContainerRelay('ncl-x', { ports: [10255], route: (port) => routed.push(port) }, rt);
    void relay.run();
    await tick();
    rt.daemonSays({ t: 'open', id: 's0', port: 22, seq: 1 });
    rt.daemonSays({ t: 'open', id: 's1', port: 10255, seq: 2 });
    rt.daemonSays({ t: 'open', id: 's1', port: 10255, seq: 2 }); // a replay after a re-attach
    await tick();
    expect(routed).toEqual([10255]);
    // The refused stream is closed back to the daemon.
    expect(rt.received.some((f) => f.t === 'close' && f.id === 's0')).toBe(true);
    relay.close();
  });

  it("closes the agent's connection when whoever serves the port destroys its end", async () => {
    const rt = new FakeRuntime();
    rt.daemonUp = true;
    const relay = new ContainerRelay('ncl-x', { ports: [10255], route: (_p, s) => s.destroy() }, rt);
    void relay.run();
    await tick();
    rt.daemonSays({ t: 'open', id: 's0', port: 10255, seq: 1 });
    await tick();
    expect(rt.received.some((f) => f.t === 'close' && f.id === 's0')).toBe(true);
    expect(relay.streamCount).toBe(0);
    relay.close();
  });

  it('re-attaches when the pipe drops, and replays what the daemon had not acknowledged', async () => {
    const rt = new FakeRuntime();
    rt.daemonUp = true;
    const routed: Duplex[] = [];
    const relay = new ContainerRelay('ncl-x', { ports: [10255], route: (_p, s) => routed.push(s) }, rt);
    void relay.run();
    await tick();
    rt.daemonSays({ t: 'open', id: 's0', port: 10255, seq: 1 });
    await tick();
    rt.dropPipe();
    routed[0].write('while detached'); // held for replay
    await new Promise((r) => setTimeout(r, 400));
    expect(relay.ready).toBe(true);
    const hellos = rt.received.filter((f) => f.t === 'hello');
    expect(hellos.length).toBe(2);
    expect(hellos[1].ack).toBe(1); // tells the new pipe what it already saw
    const replayed = rt.received.filter((f) => f.t === 'data' && f.id === 's0');
    expect(Buffer.from(String(replayed.at(-1)?.b64), 'base64').toString()).toBe('while detached');
    relay.close();
  });
});

describe('the embedded scripts', () => {
  it('parse', () => {
    expect(() => new Function(daemonScript([10255, 3001]))).not.toThrow();
    expect(() => new Function(ATTACH_SCRIPT)).not.toThrow();
  });
});

/**
 * End to end on a real engine, opt-in (RUN_DOCKER_TESTS=1 and an agent image in
 * NANOCLAW_TEST_AGENT_IMAGE): a container with no network reaches a server on
 * this machine only through the relay.
 */
const image = process.env.NANOCLAW_TEST_AGENT_IMAGE ?? '';
const docker = process.env.RUN_DOCKER_TESTS === '1' && image !== '';
describe.skipIf(!docker)('on a real engine', () => {
  const name = `ncl-exec-relay-test-${process.pid}`;
  afterEach(() => {
    spawnSync('docker', ['rm', '-f', name]);
  });

  it("a --network none container's request to host.docker.internal arrives through the pipe", async () => {
    const server = http.createServer((req, res) => res.end(`hello from the host: ${req.url}`));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const hostPort = (server.address() as AddressInfo).port;
    const containerPort = 18181;
    try {
      execFileSync('docker', [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '--network',
        'none',
        '--add-host=host.docker.internal:127.0.0.1',
        '--entrypoint',
        'sleep',
        image,
        'infinity',
      ]);
      registerRelayedContainer(name, {
        ports: [containerPort],
        route: (_port, stream) => {
          const up = net.connect({ host: '127.0.0.1', port: hostPort });
          stream.pipe(up);
          up.pipe(stream);
          up.on('error', () => stream.destroy());
        },
      });
      for (let i = 0; i < 100 && !relayReady(name); i++) await new Promise((r) => setTimeout(r, 200));
      expect(relayReady(name)).toBe(true);
      // Asynchronously: the relay runs on this event loop, which a synchronous exec would freeze.
      const inContainer = (script: string): Promise<{ ok: boolean; out: string }> =>
        new Promise((resolve) =>
          execFile('docker', ['exec', name, 'bun', '-e', script], { timeout: 20_000 }, (err, out) =>
            resolve({ ok: !err, out: String(out) }),
          ),
        );
      const viaRelay = await inContainer(
        `const r = await fetch('http://host.docker.internal:${containerPort}/via-relay'); console.log(await r.text());`,
      );
      expect(viaRelay.out.trim()).toBe('hello from the host: /via-relay');
      // And the container has no other way out.
      const direct = await inContainer("await fetch('http://1.1.1.1', {signal: AbortSignal.timeout(3000)})");
      expect(direct.ok).toBe(false);
    } finally {
      server.close();
    }
  }, 60_000);
});
